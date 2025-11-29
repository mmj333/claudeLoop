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
    
    # Capture tmux pane with ANSI colors preserved
    if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
        # Use -p to preserve colors, -e for escape sequences
        # Capture only last 500 lines for better performance
        tmux capture-pane -t "$TMUX_SESSION:0.0" -p -e -S -500 > "$ANSI_FILE.tmp"
        
        # Create clean version by stripping ANSI codes
        sed 's/\x1b\[[0-9;]*m//g' "$ANSI_FILE.tmp" > "$LOG_FILE.tmp"
        
        # Apply same incremental update logic to ANSI file
        if [ -f "$ANSI_FILE" ]; then
            # For ANSI we can just replace since it's for display only
            # and we want the latest colors/formatting
            mv "$ANSI_FILE.tmp" "$ANSI_FILE"
        else
            mv "$ANSI_FILE.tmp" "$ANSI_FILE"
        fi
        
        # Crop-filter-append with fuzzy matching for changing numbers
        if [ -f "$LOG_FILE" ]; then
            # Try to find overlap by comparing normalized content (numbers replaced with X)
            # This makes "Thinking... 5 seconds" match "Thinking... 6 seconds"
            
            # Normalize last 500 lines of log (our max capture size)
            tail -500 "$LOG_FILE" | sed 's/[0-9]/X/g' > "$LOG_FILE.tail.norm"
            
            # Find best overlap point
            OVERLAP=0
            for CHECK in 20 50 100 200 300 400 500; do
                # Normalize first CHECK lines of tmux
                head -$CHECK "$LOG_FILE.tmp" | sed 's/[0-9]/X/g' > "$LOG_FILE.tmux.norm"
                
                # See if normalized content matches
                if tail -$CHECK "$LOG_FILE.tail.norm" | cmp -s - "$LOG_FILE.tmux.norm" 2>/dev/null; then
                    OVERLAP=$CHECK
                    break
                fi
            done
            
            if [ $OVERLAP -gt 0 ]; then
                # Found overlap! Keep log minus overlap, append all tmux
                head -n -$OVERLAP "$LOG_FILE" > "$LOG_FILE.new"
                cat "$LOG_FILE.tmp" >> "$LOG_FILE.new"
                mv "$LOG_FILE.new" "$LOG_FILE"
            else
                # No overlap at all, just append
                cat "$LOG_FILE.tmp" >> "$LOG_FILE"
            fi
            
            rm -f "$LOG_FILE.tmp" "$LOG_FILE.tail.norm" "$LOG_FILE.tmux.norm"
        else
            # First run, just use the captured content
            mv "$LOG_FILE.tmp" "$LOG_FILE"
        fi
    fi
    
    # Check every 0.5 seconds for more responsive updates
    sleep 0.5
done