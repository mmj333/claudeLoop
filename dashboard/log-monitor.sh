#!/bin/bash

# Log Monitor - Just watches and saves tmux output with colors
# Enhanced with idle-aware functionality for efficiency

INSTANCE_NAME=${1:-"default"}
TMUX_SESSION=${2:-"claude-chat"}  # Allow custom tmux session
LOG_DIR="/home/michael/InfiniQuest/tmp/claudeLogs"
ANSI_LOG_DIR="/home/michael/InfiniQuest/tmp/claudeLogs/ANSI_tmp"
MONITORS_DIR="/tmp/claude-monitors"

# Instance-specific files (use -sh suffix to avoid conflicts with idle monitor)
LOCK_FILE="$MONITORS_DIR/monitor-${INSTANCE_NAME}-sh.lock"
PID_FILE="$MONITORS_DIR/monitor-${INSTANCE_NAME}-sh.pid"
SESSION_FILE="$MONITORS_DIR/monitor-${INSTANCE_NAME}.session"
IDLE_STATE_FILE="$MONITORS_DIR/monitor-${INSTANCE_NAME}-idle-state.json"

# Idle detection configuration
IDLE_THRESHOLD_MS=120000  # 2 minutes in milliseconds
VERY_IDLE_THRESHOLD_MS=360000  # 6 minutes in milliseconds
SLEEP_ACTIVE=1  # 1 second when active
SLEEP_IDLE=5    # 5 seconds when idle
SLEEP_VERY_IDLE=30  # 30 seconds when very idle
CURRENT_SLEEP=$SLEEP_ACTIVE
IDLE_LEVEL=0  # 0=active, 1=idle, 2=very idle

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

# Function to get system idle time using xprintidle
get_idle_time() {
    if command -v xprintidle >/dev/null 2>&1; then
        xprintidle 2>/dev/null || echo "0"
    else
        echo "0"  # Default to active if xprintidle not available
    fi
}

# Function to get CPU usage
get_cpu_usage() {
    # Get CPU usage percentage (100 - idle%)
    top -bn1 | grep "Cpu(s)" | sed "s/.*, *\([0-9.]*\)%* id.*/\1/" | awk '{print 100 - $1}'
}

# Function to update idle state
update_idle_state() {
    local idle_ms=$(get_idle_time)
    local cpu_usage=$(get_cpu_usage)
    local prev_level=$IDLE_LEVEL
    
    # Determine idle level based on idle time and CPU usage
    if [ $idle_ms -lt $IDLE_THRESHOLD_MS ] || (( $(echo "$cpu_usage > 10" | bc -l) )); then
        IDLE_LEVEL=0
        CURRENT_SLEEP=$SLEEP_ACTIVE
    elif [ $idle_ms -lt $VERY_IDLE_THRESHOLD_MS ]; then
        IDLE_LEVEL=1
        CURRENT_SLEEP=$SLEEP_IDLE
    else
        IDLE_LEVEL=2
        CURRENT_SLEEP=$SLEEP_VERY_IDLE
    fi
    
    # Log state changes
    if [ $prev_level -ne $IDLE_LEVEL ]; then
        case $IDLE_LEVEL in
            0) echo "🟢 Switched to Active mode (${CURRENT_SLEEP}s interval, CPU: ${cpu_usage}%)" ;;
            1) echo "🟡 Switched to Idle mode (${CURRENT_SLEEP}s interval, idle: $((idle_ms/1000))s)" ;;
            2) echo "🔴 Switched to Very Idle mode (${CURRENT_SLEEP}s interval, idle: $((idle_ms/1000))s)" ;;
        esac
    fi
    
    # Save idle state
    echo "{\"idle_level\": $IDLE_LEVEL, \"idle_ms\": $idle_ms, \"cpu_usage\": $cpu_usage, \"timestamp\": $(date +%s)}" > "$IDLE_STATE_FILE"
}

echo "📝 Starting log monitor with idle detection (instance: $INSTANCE_NAME)..."
echo "   • Watching tmux session: $TMUX_SESSION"
echo "   • Clean logs: $(get_log_file)"
echo "   • ANSI logs: ${ANSI_LOG_DIR}/$(basename "$(get_log_file)" .txt)_display.ansi"
echo "   • PID: $$"
echo "   • Instance: $INSTANCE_NAME"
echo "   • Idle detection: Active (1s) → Idle (5s) → Very Idle (30s)"
echo ""

# Initialize loop counter
LOOP_COUNT=0

# Main monitoring loop
while true; do
    LOG_FILE=$(get_log_file)
    # ANSI file has no date, just session name
    ANSI_FILE="${ANSI_LOG_DIR}/${TMUX_SESSION}.log"
    
    # Capture tmux pane with ANSI colors preserved (full scrollback)
    if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
        # Capture full tmux scrollback (up to 10000 lines)
        # This eliminates jumpiness by always showing complete history
        TMUX_OUTPUT=$(tmux capture-pane -t "$TMUX_SESSION:0.0" -p -e -S -10000)
        
        # Update ANSI file directly with full scrollback
        echo "$TMUX_OUTPUT" > "$ANSI_FILE"
        
        # For the filesystem log, we'll keep a simple stripped version
        # No more complex joining - just the current tmux content
        CLEAN_OUTPUT=$(echo "$TMUX_OUTPUT" | sed 's/\x1b\[[0-9;]*m//g')
        echo "$CLEAN_OUTPUT" > "$LOG_FILE"
    fi
    
    # Update idle state every 10 iterations or when changing modes
    if [ $((LOOP_COUNT % 10)) -eq 0 ] || [ $IDLE_LEVEL -eq 0 ]; then
        update_idle_state
    fi
    LOOP_COUNT=$((LOOP_COUNT + 1))
    
    # Use dynamic sleep interval based on idle state
    sleep $CURRENT_SLEEP
done