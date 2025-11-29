#!/bin/bash

# Log Monitor Manager - Handles multiple named instances

ACTION=$1
INSTANCE_NAME=${2:-"default"}
TMUX_SESSION=${3:-"claude-chat"}
LOG_DIR="/home/michael/InfiniQuest/tmp/claudeLogs"
MONITORS_DIR="/tmp/claude-monitors"

# Ensure directories exist
mkdir -p "$LOG_DIR" "$MONITORS_DIR"

# Instance files
LOCK_FILE="$MONITORS_DIR/monitor-${INSTANCE_NAME}.lock"
PID_FILE="$MONITORS_DIR/monitor-${INSTANCE_NAME}.pid"
CONFIG_FILE="$MONITORS_DIR/monitor-${INSTANCE_NAME}.conf"

case "$ACTION" in
    start)
        # Check if already running
        if [ -f "$PID_FILE" ]; then
            OLD_PID=$(cat "$PID_FILE")
            if ps -p "$OLD_PID" > /dev/null 2>&1; then
                echo "ERROR: Monitor '$INSTANCE_NAME' already running (PID: $OLD_PID)"
                exit 1
            fi
        fi
        
        # Check if another monitor is watching the same tmux session
        for monitor_file in "$MONITORS_DIR"/monitor-*.session; do
            if [ -f "$monitor_file" ]; then
                MONITOR_SESSION=$(cat "$monitor_file")
                MONITOR_NAME=$(basename "$monitor_file" .session | sed 's/monitor-//')
                if [ "$MONITOR_SESSION" = "$TMUX_SESSION" ] && [ "$MONITOR_NAME" != "$INSTANCE_NAME" ]; then
                    # Check if that monitor is actually running
                    MONITOR_PID_FILE="$MONITORS_DIR/monitor-${MONITOR_NAME}.pid"
                    if [ -f "$MONITOR_PID_FILE" ]; then
                        MONITOR_PID=$(cat "$MONITOR_PID_FILE")
                        if ps -p "$MONITOR_PID" > /dev/null 2>&1; then
                            echo "ERROR: Session '$TMUX_SESSION' is already being monitored by instance '$MONITOR_NAME' (PID: $MONITOR_PID)"
                            exit 1
                        fi
                    fi
                fi
            fi
        done
        
        # Start the monitor in background
        # Use idle-aware monitor for better performance
        nohup /home/michael/InfiniQuest/tmp/claudeLoop/dashboard/log-monitor-idle.sh "$INSTANCE_NAME" "$TMUX_SESSION" > "$MONITORS_DIR/monitor-${INSTANCE_NAME}.log" 2>&1 &
        NEW_PID=$!
        echo $NEW_PID > "$PID_FILE"
        
        # Clean up any stale -sh.pid files that might interfere
        rm -f "$MONITORS_DIR/monitor-${INSTANCE_NAME}-sh.pid" "$MONITORS_DIR/monitor-${INSTANCE_NAME}-sh.lock"
        
        # Save config
        echo "{
  \"instance\": \"$INSTANCE_NAME\",
  \"tmux_session\": \"$TMUX_SESSION\",
  \"pid\": $NEW_PID,
  \"started\": \"$(date -Iseconds)\",
  \"log_dir\": \"$LOG_DIR\",
  \"log_file\": \"${TMUX_SESSION}_$(date +%F).log\"
}" > "$CONFIG_FILE"
        
        echo "OK: Started monitor '$INSTANCE_NAME' (PID: $NEW_PID)"
        ;;
        
    stop)
        if [ -f "$PID_FILE" ]; then
            PID=$(cat "$PID_FILE")
            if kill -0 "$PID" 2>/dev/null; then
                kill "$PID"
                rm -f "$PID_FILE" "$LOCK_FILE" "$CONFIG_FILE"
                echo "OK: Stopped monitor '$INSTANCE_NAME' (PID: $PID)"
            else
                rm -f "$PID_FILE" "$LOCK_FILE" "$CONFIG_FILE"
                echo "OK: Cleaned up stale monitor '$INSTANCE_NAME'"
            fi
        else
            echo "ERROR: Monitor '$INSTANCE_NAME' not running"
            exit 1
        fi
        ;;
        
    status)
        if [ -f "$PID_FILE" ]; then
            PID=$(cat "$PID_FILE")
            if ps -p "$PID" > /dev/null 2>&1; then
                echo "{\"running\": true, \"pid\": $PID, \"instance\": \"$INSTANCE_NAME\"}"
            else
                echo "{\"running\": false, \"instance\": \"$INSTANCE_NAME\"}"
            fi
        else
            echo "{\"running\": false, \"instance\": \"$INSTANCE_NAME\"}"
        fi
        ;;
        
    list)
        echo "{"
        echo "  \"monitors\": ["
        first=true
        for conf in "$MONITORS_DIR"/monitor-*.conf; do
            if [ -f "$conf" ]; then
                if [ "$first" = false ]; then echo ","; fi
                cat "$conf" | sed 's/^/    /'
                first=false
            fi
        done
        echo "  ]"
        echo "}"
        ;;
        
    *)
        echo "Usage: $0 {start|stop|status|list} [instance_name] [tmux_session]"
        echo "Examples:"
        echo "  $0 start default claude-chat"
        echo "  $0 start work-tab claude-work"
        echo "  $0 start personal claude-personal"
        exit 1
        ;;
esac