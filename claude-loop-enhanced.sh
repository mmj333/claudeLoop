#!/bin/bash

# Enhanced Claude Loop with automatic pause on usage limits
# This script integrates with claude-loop-monitor.js for smart pausing

cd ~/InfiniQuest

# --- INSTANCE CONFIGURATION ---
INSTANCE_NAME="${1:-claude-loop1}"  # Allow instance name as first parameter
LOCK_FILE="/tmp/claude_loop_${INSTANCE_NAME}.lock"
PID_FILE="/tmp/claude_loop_${INSTANCE_NAME}.pid"

# Check if already running
if [ -f "$LOCK_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE" 2>/dev/null)
    if [ -n "$OLD_PID" ] && ps -p "$OLD_PID" > /dev/null 2>&1; then
        echo "❌ Claude loop instance '$INSTANCE_NAME' is already running (PID: $OLD_PID)"
        echo "   To stop it, run: kill $OLD_PID"
        exit 1
    else
        echo "🧹 Cleaning up stale lock file for '$INSTANCE_NAME'"
        rm -f "$LOCK_FILE" "$PID_FILE"
    fi
fi

# Create lock file
touch "$LOCK_FILE"
echo $$ > "$PID_FILE"

# --- CONFIGURATION ---
AUTOSAVE_INTERVAL=30  # seconds
SESSION_NAME="${INSTANCE_NAME:-claude}"  # Use instance name for tmux session
DELAY_MINUTES=10
USE_START_TIME=true
START_TIME="1:00"
LOG_DIR=~/InfiniQuest/tmp/claudeLogs
mkdir -p "$LOG_DIR"
CURRENT_DATE=$(date +%F)
CURRENT_HOUR=$(date +%H)
LOGFILE="$LOG_DIR/${INSTANCE_NAME}_${CURRENT_DATE}_$(date +%H-%M-%S)_final.txt"
AUTOSAVE_FILE="$LOG_DIR/${INSTANCE_NAME}_${CURRENT_DATE}_${CURRENT_HOUR}_autosave.txt"
MONITOR_LOG="$LOG_DIR/${INSTANCE_NAME}_monitor.log"
MAX_LOG_SIZE=$((10 * 1024 * 1024))  # 10MB in bytes
ROTATION_INTERVAL=3600  # Rotate hourly (in seconds)

# Monitor integration
MONITOR_PID=""
PAUSE_FILE="/tmp/claude_loop_${INSTANCE_NAME}_paused"
RESUME_TIME_FILE="/tmp/claude_loop_${INSTANCE_NAME}_resume_time"

MESSAGE=""
# MESSAGE="Thank you! Please continue to improve the project. Either read ./PROJECT_INDEX.md and ./SESSION_TODOS.md and CLAUDE.md into context or (first run node scripts/show-est-time.js to get current time) and then update them if you feel you have some useful info to add to them at this point. And update CHANGELOG.md when appropriate. And read or write any other .md files in the zdocs[/*] directory when it might provide helpful context."

# --- FUNCTIONS ---
function start_usage_monitor() {
  echo "🔍 Starting usage limit monitor..."
  
  # Start the monitor in the background, capturing both stdout and the log
  node scripts/claude-loop-monitor.js > "$MONITOR_LOG" 2>&1 &
  MONITOR_PID=$!
  
  # Give it a moment to start
  sleep 2
  
  # Set up a file watcher for pause signals
  (
    while true; do
      if [[ -f "$PAUSE_FILE" && -f "$RESUME_TIME_FILE" ]]; then
        local resume_time=$(cat "$RESUME_TIME_FILE")
        echo -e "\n⏸️  Usage limit detected! Pausing until $resume_time"
        echo "   (Monitor detected Claude usage limit)"
        
        # Calculate wait time
        local now_epoch=$(date +%s)
        local resume_epoch=$(date -d "$resume_time" +%s)
        local wait_seconds=$((resume_epoch - now_epoch))
        
        if (( wait_seconds > 0 )); then
          echo "   Waiting $((wait_seconds / 60)) minutes..."
          sleep $wait_seconds
        fi
        
        # Clean up pause files
        rm -f "$PAUSE_FILE" "$RESUME_TIME_FILE"
        echo -e "\n▶️  Resuming Claude loop..."
      fi
      sleep 5
    done
  ) &
  PAUSE_WATCHER_PID=$!
}

function check_usage_limit_in_output() {
  # Check the last 100 lines of tmux output for usage limit messages
  local recent_output=$(tmux capture-pane -pt "$SESSION_NAME" -S -100 2>/dev/null)
  
  if echo "$recent_output" | grep -qiE "(usage limit reached|limit will reset at|rate limit exceeded)"; then
    # Extract reset time if possible
    local reset_time=$(echo "$recent_output" | grep -oiE "reset at ([0-9]+:?[0-9]*\s*(am|pm)?)" | tail -1)
    
    if [[ -n "$reset_time" ]]; then
      echo "⚠️  Usage limit detected in Claude output!"
      echo "   Message found: $reset_time"
      
      # Parse the time
      local hour minute ampm
      if [[ "$reset_time" =~ ([0-9]+):?([0-9]*)\s*(am|pm)? ]]; then
        hour="${BASH_REMATCH[1]}"
        minute="${BASH_REMATCH[2]:-00}"
        ampm="${BASH_REMATCH[3]}"
        
        # Convert to 24-hour format
        if [[ "$ampm" == "pm" && "$hour" != "12" ]]; then
          hour=$((hour + 12))
        elif [[ "$ampm" == "am" && "$hour" == "12" ]]; then
          hour=0
        fi
        
        # Create resume time
        local resume_datetime=$(date -d "today $hour:$minute" +"%Y-%m-%d %H:%M:%S")
        local now_epoch=$(date +%s)
        local resume_epoch=$(date -d "$resume_datetime" +%s)
        
        # If time is in the past, assume tomorrow
        if (( resume_epoch <= now_epoch )); then
          resume_datetime=$(date -d "tomorrow $hour:$minute" +"%Y-%m-%d %H:%M:%S")
        fi
        
        # Signal pause
        echo "$resume_datetime" > "$RESUME_TIME_FILE"
        touch "$PAUSE_FILE"
        
        return 0
      fi
    fi
  fi
  
  return 1
}

function rotate_logs_if_needed() {
  # Check log size and rotate if > 10MB
  if [[ -f "$AUTOSAVE_FILE" ]]; then
    local size=$(stat -c%s "$AUTOSAVE_FILE" 2>/dev/null || echo 0)
    if (( size > 10485760 )); then  # 10MB
      echo "📊 Rotating large log file ($(( size / 1048576 ))MB)..."
      local timestamp=$(date +%Y%m%d_%H%M%S)
      mv "$AUTOSAVE_FILE" "$LOG_DIR/claude_rotated_${timestamp}.log"
      echo "✅ Log rotated to claude_rotated_${timestamp}.log"
    fi
  fi
}

# Include all the original functions from claude_continue_loop.sh
function handle_interrupt() {
  echo -e "\n📝 Saving logs and cleaning up for instance '$INSTANCE_NAME'..."
  
  # Kill monitor processes
  [[ -n "$MONITOR_PID" ]] && kill "$MONITOR_PID" 2>/dev/null
  [[ -n "$PAUSE_WATCHER_PID" ]] && kill "$PAUSE_WATCHER_PID" 2>/dev/null
  [[ -n "$AUTOSAVE_PID" ]] && kill "$AUTOSAVE_PID" 2>/dev/null
  
  # Clean up pause files
  rm -f "$PAUSE_FILE" "$RESUME_TIME_FILE"
  
  # Clean up lock files
  rm -f "$LOCK_FILE" "$PID_FILE"
  
  save_tmux_history
  restore_sleep
  stty sane
  exit 0
}

# Set up signal handlers
trap 'handle_interrupt' SIGINT SIGTERM

# Copy all other functions from original script...
# (countdown, disable_sleep, restore_sleep, etc. - omitted for brevity)

# --- MAIN EXECUTION ---
echo "🚀 Enhanced Claude Loop Starting (Instance: $INSTANCE_NAME, PID: $$)..."
echo "   - Automatic pause on usage limits ✓"
echo "   - Log rotation at 10MB ✓"
echo "   - Smart session management ✓"
echo "   - Instance locking enabled ✓"

# Start the usage monitor
start_usage_monitor

# Check tmux session
check_or_start_tmux_session
disable_sleep

# Start autosave with rotation
(
  while true; do
    tmux capture-pane -pt "$SESSION_NAME" -S -10000 > "$AUTOSAVE_FILE"
    rotate_logs_if_needed
    sleep "$AUTOSAVE_INTERVAL"
  done
) &
AUTOSAVE_PID=$!

# Wait for start time if configured
if [ "$USE_START_TIME" = true ]; then
  wait_until_start_time
fi

echo "[$(date)] 🚀 Enhanced Claude loop started"
echo "Features: auto-pause on limits, log rotation, smart monitoring"
echo "Ctrl+C to exit gracefully"

# Main message loop with pause checking
while true; do
  # Check if we're paused
  if [[ -f "$PAUSE_FILE" ]]; then
    sleep 10
    continue
  fi
  
  # Send message
  tmux send-keys -t "$SESSION_NAME" "$MESSAGE"
  sleep 0.4
  tmux send-keys -t "$SESSION_NAME" Enter
  echo "[$(date)] ✅ Sent message"
  
  # Check for usage limit in output after sending
  sleep 5  # Give Claude time to respond
  if check_usage_limit_in_output; then
    continue  # Skip the countdown if we detected a limit
  fi
  
  # Normal countdown
  countdown $((DELAY_MINUTES * 60))
done