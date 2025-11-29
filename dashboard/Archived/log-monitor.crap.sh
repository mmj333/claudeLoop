#!/bin/bash

# Log Monitor - Just watches and saves tmux output with colors
# No Claude interaction, just pure log capture

INSTANCE_NAME=${1:-"default"}
TMUX_SESSION=${2:-"claude-chat"}  # Allow custom tmux session
LOG_DIR="/home/michael/InfiniQuest/tmp/claudeLogs"
ANSI_LOG_DIR="/home/michael/InfiniQuest/tmp/claudeLogs/ANSI_tmp"
MONITORS_DIR="/tmp/claude-monitors"

# Instance-specific files (use -sh suffix to avoid conflicts with idle monitor)
LOCK_FILE="$MONITORS_DIR/monitor-${INSTANCE_NAME}-sh.lock"
PID_FILE="$MONITORS_DIR/monitor-${INSTANCE_NAME}-sh.pid"
SESSION_FILE="$MONITORS_DIR/monitor-${INSTANCE_NAME}.session"

# Ensure directories exist
mkdir -p "$LOG_DIR" "$ANSI_LOG_DIR" "$MONITORS_DIR"

# Save the tmux session name
echo "$TMUX_SESSION" > "$SESSION_FILE"

# Ensure log directory exists
mkdir -p "$LOG_DIR"

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

# Create lock file
touch "$LOCK_FILE"
echo $$ > "$PID_FILE"

# Cleanup on exit
cleanup() {
    echo "🛑 Stopping log monitor..."
    rm -f "$LOCK_FILE" "$PID_FILE"
    exit 0
}

trap cleanup EXIT INT TERM

# Function to get current log file
get_log_file() {
    # Clean logs with date for archival
    echo "${LOG_DIR}/${TMUX_SESSION}_$(date +%F).log"
}

echo "📝 Starting log monitor (instance: $INSTANCE_NAME)..."
echo "   • Watching tmux session: $TMUX_SESSION"
echo "   • Clean logs: $(get_log_file)"
echo "   • ANSI logs: ${ANSI_LOG_DIR}/$(basename "$(get_log_file)" .txt)_display.ansi"
echo "   • PID: $$"
echo "   • Instance: $INSTANCE_NAME"
echo ""

# Main monitoring loop
while true; do
    LOG_FILE=$(get_log_file)
    # ANSI file has no date, just session name
    ANSI_FILE="${ANSI_LOG_DIR}/${TMUX_SESSION}.log"
    
    # Capture tmux pane with ANSI colors preserved (all in memory)
    if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
        # Capture tmux output to memory
        TMUX_OUTPUT=$(tmux capture-pane -t "$TMUX_SESSION:0.0" -p -e -S -500)
        
        # Update ANSI file directly
        echo "$TMUX_OUTPUT" > "$ANSI_FILE"
        
        # Strip ANSI codes for clean log
        CLEAN_OUTPUT=$(echo "$TMUX_OUTPUT" | sed 's/\x1b\[[0-9;]*m//g')
        
        # Keep track of what we've seen using the last line
        if [ -f "$LOG_FILE" ]; then
            # Get the last non-empty line from our log
            LAST_LOGGED_LINE=$(tail -20 "$LOG_FILE" | grep -v '^$' | tail -1)
            
            if [ -n "$LAST_LOGGED_LINE" ]; then
                # Find this line in tmux output
                LINE_FOUND=false
                LINE_NUM=0
                
                while IFS= read -r line; do
                    LINE_NUM=$((LINE_NUM + 1))
                    if [ "$line" = "$LAST_LOGGED_LINE" ]; then
                        LINE_FOUND=true
                        # Append everything after this line
                        NEW_CONTENT=$(echo "$CLEAN_OUTPUT" | tail -n +$((LINE_NUM + 1)))
                        if [ -n "$NEW_CONTENT" ]; then
                            echo "$NEW_CONTENT" >> "$LOG_FILE"
                        fi
                        break
                    fi
                done <<< "$CLEAN_OUTPUT"
                
                # If we didn't find our last line, tmux buffer probably rotated
                if [ "$LINE_FOUND" = "false" ]; then
                    # Just append the bottom portion to avoid massive duplicates
                    echo "$CLEAN_OUTPUT" | tail -100 >> "$LOG_FILE"
                fi
            else
                # Empty log or only blank lines, append everything
                echo "$CLEAN_OUTPUT" >> "$LOG_FILE"
            fi
        else
            # First run, create the log file
            echo "$CLEAN_OUTPUT" > "$LOG_FILE"
        fi
    fi
    
    # Check every 0.5 seconds for more responsive updates
    sleep 0.5
done