#!/bin/bash

# Enhanced Claude Loop V2 with Improved Log Management
# - Uses improved monitor with smart log rotation
# - Single current log file that rotates daily or at 1MB
# - Incremental content appending to minimize overlap
# - Better pause/resume handling for usage limits

cd ~/InfiniQuest

# --- CONFIGURATION ---
SESSION_NAME="claude-loop1"
DELAY_MINUTES=10
USE_START_TIME=true
START_TIME="1:00"
LOG_DIR=~/InfiniQuest/tmp/claudeLogs
mkdir -p "$LOG_DIR"

# Monitor files
PAUSE_FILE="/tmp/claude_loop_paused"
RESUME_TIME_FILE="/tmp/claude_loop_resume_time"
MONITOR_PID=""
MONITOR_SCRIPT="tmp/claudeLoop/dashboard/claude-loop-monitor-idle-aware.js"

MESSAGE = ""
# MESSAGE="Thank you! Please continue to improve the project. Either read ./PROJECT_INDEX.md and ./SESSION_TODOS.md and CLAUDE.md into context or (first run node scripts/show-est-time.js to get current time) and then update them if you feel you have some useful info to add to them at this point. And update CHANGELOG.md when appropriate. And read or write any other .md files in the zdocs[/*] directory when it might provide helpful context."

# --- FUNCTIONS ---
function start_improved_monitor() {
  echo "🔍 Starting improved log monitor..."
  
  # Start the improved monitor
  node "$MONITOR_SCRIPT" &
  MONITOR_PID=$!
  
  # Give it a moment to initialize
  sleep 2
  
  echo "✅ Monitor started (PID: $MONITOR_PID)"
}

function wait_for_resume() {
  while [[ -f "$PAUSE_FILE" ]]; do
    if [[ -f "$RESUME_TIME_FILE" ]]; then
      local resume_time=$(cat "$RESUME_TIME_FILE")
      local resume_formatted=$(date -d "$resume_time" "+%I:%M %p")
      echo -e "\r⏸️  Paused until $resume_formatted (usage limit detected)..."
    fi
    sleep 5
  done
}

function check_or_start_tmux_session() {
  if ! tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "🚀 Creating new tmux session: $SESSION_NAME"
    tmux new-session -d -s "$SESSION_NAME"
    sleep 1
  else
    echo "✅ Tmux session '$SESSION_NAME' already exists"
  fi
}

function disable_sleep() {
  if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    caffeinate -d -i -m -s &
    CAFFEINATE_PID=$!
    echo "☕ Sleep disabled on macOS (PID: $CAFFEINATE_PID)"
  elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux
    if command -v systemd-inhibit &> /dev/null; then
      systemd-inhibit --what=idle --who="Claude Loop" --why="Automation running" --mode=block sleep infinity &
      INHIBIT_PID=$!
      echo "🔒 Sleep disabled on Linux (PID: $INHIBIT_PID)"
    fi
  fi
}

function restore_sleep() {
  if [[ -n "$CAFFEINATE_PID" ]]; then
    kill "$CAFFEINATE_PID" 2>/dev/null
    echo "💤 Sleep restored on macOS"
  fi
  if [[ -n "$INHIBIT_PID" ]]; then
    kill "$INHIBIT_PID" 2>/dev/null
    echo "💤 Sleep restored on Linux"
  fi
}

function countdown() {
  local seconds=$1
  while [ $seconds -gt 0 ]; do
    # Check if paused
    if [[ -f "$PAUSE_FILE" ]]; then
      wait_for_resume
      return
    fi
    
    printf "\r⏱️  Next message in: %02d:%02d" $((seconds/60)) $((seconds%60))
    sleep 1
    ((seconds--))
  done
  printf "\r✅ Sending message...                    \n"
}

function wait_until_start_time() {
  local target_hour=$(echo "$START_TIME" | cut -d: -f1)
  local target_minute=$(echo "$START_TIME" | cut -d: -f2)
  
  while true; do
    local current_hour=$(date +%H | sed 's/^0//')
    local current_minute=$(date +%M | sed 's/^0//')
    local current_total=$((current_hour * 60 + current_minute))
    local target_total=$((target_hour * 60 + target_minute))
    
    if [ $current_total -ge $target_total ]; then
      echo "✅ Start time reached!"
      break
    fi
    
    local wait_minutes=$((target_total - current_total))
    echo "⏰ Waiting until $START_TIME (${wait_minutes} minutes)..."
    sleep 60
  done
}

function handle_interrupt() {
  echo -e "\n\n📝 Gracefully shutting down..."
  
  # Kill monitor
  if [[ -n "$MONITOR_PID" ]]; then
    echo "🛑 Stopping monitor..."
    kill "$MONITOR_PID" 2>/dev/null
    wait "$MONITOR_PID" 2>/dev/null
  fi
  
  # Clean up pause files
  rm -f "$PAUSE_FILE" "$RESUME_TIME_FILE"
  
  # Restore sleep settings
  restore_sleep
  
  # Reset terminal
  stty sane
  
  echo "✅ Claude loop stopped cleanly"
  exit 0
}

# --- MAIN EXECUTION ---
clear
echo "═══════════════════════════════════════════════════════════"
echo "   🚀 Enhanced Claude Loop V2 - Starting"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "📋 Configuration:"
echo "   • Session: $SESSION_NAME"
echo "   • Delay: $DELAY_MINUTES minutes"
echo "   • Log rotation: Daily at midnight or 1MB"
echo "   • Smart pause on usage limits"
echo ""

# Set up signal handlers
trap 'handle_interrupt' SIGINT SIGTERM

# Initialize
check_or_start_tmux_session
disable_sleep
start_improved_monitor

# Wait for start time if configured
if [ "$USE_START_TIME" = true ]; then
  wait_until_start_time
fi

echo ""
echo "🎯 Claude loop is now active!"
echo "   • Ctrl+C to stop gracefully"
echo "   • Logs: $LOG_DIR/claude_$(date +%F)_current.txt"
echo ""
echo "═══════════════════════════════════════════════════════════"
echo ""

# Main message loop
while true; do
  # Check if paused
  if [[ -f "$PAUSE_FILE" ]]; then
    wait_for_resume
    continue
  fi
  
  # Send message to tmux
  tmux send-keys -t "$SESSION_NAME" "$MESSAGE" 
  # Enter
  echo "[$(date '+%I:%M:%S %p')] ✅ Message sent"
  
  # Countdown to next message
  countdown $((DELAY_MINUTES * 60))
done