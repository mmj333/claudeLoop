#!/bin/bash

# Enhanced Log Monitor with Idle Detection and Dynamic Intervals
# More efficient than the JS version while maintaining all features

INSTANCE_NAME=${1:-"default"}
TMUX_SESSION=${2:-"claude-chat"}
LOG_DIR="/home/michael/InfiniQuest/tmp/claudeLogs"
ANSI_LOG_DIR="/home/michael/InfiniQuest/tmp/claudeLogs/ANSI_tmp"
MONITORS_DIR="/tmp/claude-monitors"
CONFIG_FILE="$MONITORS_DIR/monitor-${INSTANCE_NAME}-config.json"

# Default intervals (in seconds)
INTERVAL_ACTIVE=2
INTERVAL_IDLE=15
INTERVAL_MAX_IDLE=60
IDLE_THRESHOLD_MINUTES=2
LONG_IDLE_THRESHOLD_MINUTES=10

# Instance-specific files
LOCK_FILE="$MONITORS_DIR/monitor-${INSTANCE_NAME}.lock"
PID_FILE="$MONITORS_DIR/monitor-${INSTANCE_NAME}.pid"
STATE_FILE="$MONITORS_DIR/monitor-${INSTANCE_NAME}-state.json"

# Ensure directories exist
mkdir -p "$LOG_DIR" "$ANSI_LOG_DIR" "$MONITORS_DIR"

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
    rm -f "$LOCK_FILE" "$PID_FILE" "$STATE_FILE"
    exit 0
}

trap cleanup EXIT INT TERM

# Function to get current log file
get_log_file() {
    echo "${LOG_DIR}/${TMUX_SESSION}_$(date +%F).log"
}

# Function to read config if exists
read_config() {
    if [ -f "$CONFIG_FILE" ]; then
        # Read values from JSON config
        INTERVAL_ACTIVE=$(jq -r '.checkIntervalActive // 2' "$CONFIG_FILE" 2>/dev/null || echo 2)
        INTERVAL_IDLE=$(jq -r '.checkIntervalIdle // 15' "$CONFIG_FILE" 2>/dev/null || echo 15)
        INTERVAL_MAX_IDLE=$(jq -r '.checkIntervalMaxIdle // 60' "$CONFIG_FILE" 2>/dev/null || echo 60)
        IDLE_THRESHOLD_MINUTES=$(jq -r '.userIdleThresholdMinutes // 2' "$CONFIG_FILE" 2>/dev/null || echo 2)
        LONG_IDLE_THRESHOLD_MINUTES=$(jq -r '.userLongIdleThresholdMinutes // 10' "$CONFIG_FILE" 2>/dev/null || echo 10)
    fi
}

# Function to detect idle time
get_idle_time_minutes() {
    local idle_ms=0
    
    # Try xprintidle first (most accurate)
    if command -v xprintidle &> /dev/null; then
        idle_ms=$(xprintidle 2>/dev/null || echo 0)
        echo $(( idle_ms / 60000 ))
        return
    fi
    
    # Try xssstate
    if command -v xssstate &> /dev/null; then
        idle_ms=$(xssstate -i 2>/dev/null || echo 0)
        echo $(( idle_ms / 60000 ))
        return
    fi
    
    # Try loginctl
    if command -v loginctl &> /dev/null; then
        local idle_hint=$(loginctl show-session $(loginctl list-sessions --no-pager | grep $(whoami) | head -1 | awk '{print $1}') -p IdleSinceHint --no-pager 2>/dev/null | cut -d= -f2)
        if [ -n "$idle_hint" ] && [ "$idle_hint" != "0" ]; then
            local idle_timestamp=$(date -d "$idle_hint" +%s 2>/dev/null || echo 0)
            local now=$(date +%s)
            echo $(( (now - idle_timestamp) / 60 ))
            return
        fi
    fi
    
    # Default: assume active
    echo 0
}

# Function to determine current interval based on idle state
get_current_interval() {
    local idle_minutes=$(get_idle_time_minutes)
    local idle_level=0
    
    if [ $idle_minutes -lt $IDLE_THRESHOLD_MINUTES ]; then
        idle_level=0
        echo $INTERVAL_ACTIVE
    elif [ $idle_minutes -lt $LONG_IDLE_THRESHOLD_MINUTES ]; then
        idle_level=1
        echo $INTERVAL_IDLE
    else
        idle_level=2
        echo $INTERVAL_MAX_IDLE
    fi
    
    # Save state
    echo "{\"idleLevel\": $idle_level, \"idleMinutes\": $idle_minutes, \"timestamp\": \"$(date -Iseconds)\"}" > "$STATE_FILE"
}

# Initialize
echo "✅ Enhanced log monitor started ($TMUX_SESSION)"
echo "   • PID: $$"
echo "   • Dynamic intervals: ${INTERVAL_ACTIVE}s (active) → ${INTERVAL_IDLE}s (idle) → ${INTERVAL_MAX_IDLE}s (long idle)"

# Main monitoring loop
LAST_CONFIG_CHECK=$(date +%s)
CURRENT_INTERVAL=$INTERVAL_ACTIVE
ITERATION_COUNT=0

while true; do
    # Read config every 30 seconds
    NOW=$(date +%s)
    if [ $((NOW - LAST_CONFIG_CHECK)) -gt 30 ]; then
        read_config
        LAST_CONFIG_CHECK=$NOW
    fi
    
    # Get dynamic interval based on idle state
    NEW_INTERVAL=$(get_current_interval)
    if [ "$NEW_INTERVAL" != "$CURRENT_INTERVAL" ]; then
        CURRENT_INTERVAL=$NEW_INTERVAL
        case $CURRENT_INTERVAL in
            $INTERVAL_ACTIVE) echo "🔄 User Active (${CURRENT_INTERVAL}s interval)" ;;
            $INTERVAL_IDLE) echo "🔄 User Idle (${CURRENT_INTERVAL}s interval)" ;;
            $INTERVAL_MAX_IDLE) echo "🔄 User Long Idle (${CURRENT_INTERVAL}s interval)" ;;
        esac
    fi
    
    LOG_FILE=$(get_log_file)
    ANSI_FILE="${ANSI_LOG_DIR}/${TMUX_SESSION}.log"
    
    # Capture tmux pane with ANSI colors preserved
    if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
        # Use -p to preserve colors, -e for escape sequences, -S - for entire history
        tmux capture-pane -t "$TMUX_SESSION:0.0" -p -e -S - -E - > "$ANSI_FILE.tmp"
        
        # Create clean version by stripping ANSI codes
        sed 's/\x1b\[[0-9;]*m//g' "$ANSI_FILE.tmp" > "$LOG_FILE.tmp"
        
        # Update ANSI version if changed
        if [ -f "$ANSI_FILE" ]; then
            if ! cmp -s "$ANSI_FILE.tmp" "$ANSI_FILE"; then
                mv "$ANSI_FILE.tmp" "$ANSI_FILE"
            else
                rm -f "$ANSI_FILE.tmp"
            fi
        else
            mv "$ANSI_FILE.tmp" "$ANSI_FILE"
        fi
        
        # Update clean version if changed OR if bottom lines differ
        if [ -f "$LOG_FILE" ]; then
            # Check if files differ overall
            if ! cmp -s "$LOG_FILE.tmp" "$LOG_FILE"; then
                mv "$LOG_FILE.tmp" "$LOG_FILE"
            else
                # Even if overall file is same, check if last 20 lines differ
                # This catches updates to the bottom of the console
                tail -20 "$LOG_FILE.tmp" > "$LOG_FILE.tail.tmp"
                tail -20 "$LOG_FILE" > "$LOG_FILE.tail.old" 2>/dev/null || touch "$LOG_FILE.tail.old"
                
                if ! cmp -s "$LOG_FILE.tail.tmp" "$LOG_FILE.tail.old"; then
                    # Bottom changed, update the file
                    mv "$LOG_FILE.tmp" "$LOG_FILE"
                else
                    rm -f "$LOG_FILE.tmp"
                fi
                
                # Cleanup tail files
                rm -f "$LOG_FILE.tail.tmp" "$LOG_FILE.tail.old"
            fi
        else
            mv "$LOG_FILE.tmp" "$LOG_FILE"
        fi
    fi
    
    # Cleanup old logs periodically (every 100 iterations)
    if [ $((ITERATION_COUNT % 100)) -eq 0 ]; then
        # Keep only last 20 logs per session
        find "$LOG_DIR" -name "${TMUX_SESSION}_*.log" -type f | sort -r | tail -n +21 | xargs -r rm -f
        find "$ANSI_LOG_DIR" -name "${TMUX_SESSION}*.log" -type f | sort -r | tail -n +21 | xargs -r rm -f
    fi
    ITERATION_COUNT=$((ITERATION_COUNT + 1))
    
    # Check for usage limit in captured content
    if [ -f "$LOG_FILE.tmp" ]; then
        # Look for usage limit patterns
        if grep -qiE "(usage limit|limit reached|try again at|limit will reset at).*([0-9]{1,2}):([0-9]{2}).*(am|pm)" "$LOG_FILE.tmp"; then
            # Extract the time from the message
            LIMIT_LINE=$(grep -iE "(usage limit|limit reached|try again at|limit will reset at).*([0-9]{1,2}):([0-9]{2}).*(am|pm)" "$LOG_FILE.tmp" | tail -1)
            if [ -n "$LIMIT_LINE" ]; then
                echo "⚠️  Usage limit detected: $LIMIT_LINE"
                
                # Extract hour, minute, and am/pm
                TIME_MATCH=$(echo "$LIMIT_LINE" | grep -oE "([0-9]{1,2}):([0-9]{2}).*(am|pm)" | tail -1)
                if [ -n "$TIME_MATCH" ]; then
                    HOUR=$(echo "$TIME_MATCH" | cut -d: -f1)
                    MINUTE=$(echo "$TIME_MATCH" | cut -d: -f2 | cut -d' ' -f1)
                    AMPM=$(echo "$TIME_MATCH" | grep -oE "(am|pm)" | tail -1)
                    
                    # Convert to 24-hour format
                    if [ "$AMPM" = "pm" ] && [ "$HOUR" -ne 12 ]; then
                        HOUR=$((HOUR + 12))
                    elif [ "$AMPM" = "am" ] && [ "$HOUR" -eq 12 ]; then
                        HOUR=0
                    fi
                    
                    # Create resume time (tomorrow if time already passed)
                    RESUME_TIME=$(date -d "today $HOUR:$MINUTE" +%s)
                    NOW=$(date +%s)
                    if [ $RESUME_TIME -le $NOW ]; then
                        RESUME_TIME=$(date -d "tomorrow $HOUR:$MINUTE" +%s)
                    fi
                    
                    # Write pause files
                    echo "1" > "/tmp/claude_loop_paused_${TMUX_SESSION}"
                    date -d "@$RESUME_TIME" -Iseconds > "/tmp/claude_loop_resume_time_${TMUX_SESSION}"
                    
                    echo "   Will resume at: $(date -d "@$RESUME_TIME")"
                fi
            fi
        fi
    fi
    
    # Sleep for dynamic interval
    sleep $CURRENT_INTERVAL
done