#!/bin/bash

# Wrapper script to start the idle-aware Node.js monitor
# This replaces the shell script monitor

INSTANCE_NAME=${1:-"default"}
TMUX_SESSION=${2:-"claude-chat"}
MONITORS_DIR="/tmp/claude-monitors"

# Instance-specific files
LOCK_FILE="$MONITORS_DIR/monitor-${INSTANCE_NAME}.lock"
PID_FILE="$MONITORS_DIR/monitor-${INSTANCE_NAME}.pid"
SESSION_FILE="$MONITORS_DIR/monitor-${INSTANCE_NAME}.session"

# Ensure directories exist
mkdir -p "$MONITORS_DIR"

# Check if already running
if [ -f "$LOCK_FILE" ]; then
    if [ -f "$PID_FILE" ]; then
        OLD_PID=$(cat "$PID_FILE")
        if ps -p "$OLD_PID" > /dev/null 2>&1; then
            echo "❌ Log monitor already running (PID: $OLD_PID)"
            exit 1
        else
            echo "🧹 Cleaning up stale lock file"
            rm -f "$LOCK_FILE" "$PID_FILE"
        fi
    fi
fi

# Save the tmux session name
echo "$TMUX_SESSION" > "$SESSION_FILE"

# Start the Node.js idle-aware monitor
echo "🚀 Starting idle-aware monitor for $TMUX_SESSION..."
cd /home/michael/InfiniQuest

# Export session name for the monitor
export SESSION_NAME="$TMUX_SESSION"

# Check for monitor type preference (default to SH for efficiency)
MONITOR_TYPE_FILE="$MONITORS_DIR/monitor-type-preference"
MONITOR_TYPE="sh"
if [ -f "$MONITOR_TYPE_FILE" ]; then
    MONITOR_TYPE=$(cat "$MONITOR_TYPE_FILE")
fi

# Start monitor in background based on type
if [ "$MONITOR_TYPE" = "sh" ]; then
    # Use simple bash monitor (with duplicate fix)
    echo "🐚 Starting SH monitor (efficient) for $TMUX_SESSION..."
    nohup /home/michael/InfiniQuest/tmp/claudeLoop/dashboard/log-monitor.sh "$INSTANCE_NAME" "$TMUX_SESSION" > "$MONITORS_DIR/monitor-${INSTANCE_NAME}-sh.log" 2>&1 &
else
    # Use optimized JS monitor
    echo "🟨 Starting JS monitor for $TMUX_SESSION..."
    nohup node --max-old-space-size=256 tmp/claudeLoop/management/log-monitor-improved.js > "$MONITORS_DIR/monitor-${INSTANCE_NAME}-node.log" 2>&1 &
fi
PID=$!

# Save PID
echo $PID > "$PID_FILE"
touch "$LOCK_FILE"

echo "✅ Started idle-aware monitor (PID: $PID)"
echo "📊 Monitor log: $MONITORS_DIR/monitor-${INSTANCE_NAME}-node.log"

# Keep script running to maintain the process
wait $PID

# Cleanup on exit
rm -f "$LOCK_FILE" "$PID_FILE" "$SESSION_FILE"