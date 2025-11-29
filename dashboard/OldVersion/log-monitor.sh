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
    
    # Capture tmux pane with ANSI colors preserved (all in memory)
    if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
        # Capture tmux output to memory
        TMUX_OUTPUT=$(tmux capture-pane -t "$TMUX_SESSION:0.0" -p -e -S -500)
        
        # Update ANSI file directly
        echo "$TMUX_OUTPUT" > "$ANSI_FILE"
        
        # Strip ANSI codes for clean log
        CLEAN_OUTPUT=$(echo "$TMUX_OUTPUT" | sed 's/\x1b\[[0-9;]*m//g')
        
        # Efficient approach: do everything in memory, write once
        if [ -f "$LOG_FILE" ]; then
            # Read the entire log into memory
            LOG_CONTENT=$(cat "$LOG_FILE")
            LOG_SIZE=$(echo "$LOG_CONTENT" | wc -l)
            
            # Step 1: Crop log in memory (remove last 50 lines)
            if [ $LOG_SIZE -gt 50 ]; then
                CROPPED_LOG=$(echo "$LOG_CONTENT" | head -n -50)
            else
                CROPPED_LOG=""
            fi
            
            # Step 2: Get reference from the cropped log
            REFERENCE_LINES=$(echo "$CROPPED_LOG" | tail -20 | grep -v '^$' | tail -10)
            
            if [ -n "$REFERENCE_LINES" ]; then
                # Step 3: Find where reference appears in tmux
                FOUND_AT=0
                TOTAL_LINES=$(echo "$CLEAN_OUTPUT" | wc -l)
                
                # Simple search for the reference block
                for ((i=1; i<=TOTAL_LINES-9; i++)); do
                    TMUX_BLOCK=$(echo "$CLEAN_OUTPUT" | sed -n "$i,$((i+9))p")
                    if [ "$TMUX_BLOCK" = "$REFERENCE_LINES" ]; then
                        FOUND_AT=$((i+9))
                        break
                    fi
                done
                
                # Step 4: Build final content in memory
                if [ $FOUND_AT -gt 0 ]; then
                    # Found the reference, append everything after it
                    NEW_CONTENT=$(echo "$CLEAN_OUTPUT" | tail -n +$((FOUND_AT + 1)))
                    if [ -n "$NEW_CONTENT" ]; then
                        # Combine cropped log with new content
                        FINAL_LOG="${CROPPED_LOG}"$'\n'"${NEW_CONTENT}"
                    else
                        # No new content, just use cropped log
                        FINAL_LOG="$CROPPED_LOG"
                    fi
                else
                    # Didn't find reference, tmux has scrolled
                    # Append the last 50 lines
                    NEW_CONTENT=$(echo "$CLEAN_OUTPUT" | tail -50)
                    FINAL_LOG="${CROPPED_LOG}"$'\n'"${NEW_CONTENT}"
                fi
            else
                # No reference lines (log is empty or very small)
                NEW_CONTENT=$(echo "$CLEAN_OUTPUT" | tail -100)
                if [ -n "$CROPPED_LOG" ]; then
                    FINAL_LOG="${CROPPED_LOG}"$'\n'"${NEW_CONTENT}"
                else
                    FINAL_LOG="$NEW_CONTENT"
                fi
            fi
            
            # Step 5: Write once only if content changed
            if [ "$FINAL_LOG" != "$LOG_CONTENT" ]; then
                echo "$FINAL_LOG" > "$LOG_FILE"
            fi
        else
            # First run, create the log file
            echo "$CLEAN_OUTPUT" > "$LOG_FILE"
        fi
    fi
    
    # Update idle state every 10 iterations or when changing modes
    if [ $((LOOP_COUNT % 10)) -eq 0 ] || [ $IDLE_LEVEL -eq 0 ]; then
        update_idle_state
    fi
    LOOP_COUNT=$((LOOP_COUNT + 1))
    
    # Use dynamic sleep interval based on idle state
    sleep $CURRENT_SLEEP
done