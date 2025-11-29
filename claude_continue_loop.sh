#!/bin/bash

cd ~/InfiniQuest

# --- CONFIGURATION ---
AUTOSAVE_INTERVAL=30  # seconds
SESSION_NAME="claude"
DELAY_MINUTES=10
USE_START_TIME=false         # Set to "false" to skip waiting for START_TIME
START_TIME="15:32"           # Format: HH:MM (24-hour clock)
LOG_DIR=~/InfiniQuest/tmp/claudeLogs
mkdir -p "$LOG_DIR"
CURRENT_DATE=$(date +%F)
LOGFILE="$LOG_DIR/claude_${CURRENT_DATE}_$(date +%H-%M-%S)_final.txt"
AUTOSAVE_FILE="$LOG_DIR/claude_${CURRENT_DATE}_current.txt"
MAX_LOG_SIZE=$((1024 * 1024))  # 1MB in bytes

MESSAGE=""
# MESSAGE="Please continue --  Further context: read end of tmp/claudeLogs/claude_YYYY_MM_DD_current.txt and/or end of latest and/or end of 2nd latest: tmp/claudeLogs file and latest or relevant tmp/trace_logs file."
# MESSAGE="Please continue with what you're doing. And when you think you're done, try to fully test user experience on the site. Further context: read end of tmp/claudeLogs/claude_YYYY_MM_DD_current.txt and/or end of latest and/or end of 2nd latest: tmp/claudeLogs file and latest or relevant tmp/trace_logs file. Also: ./PROJECT_INDEX.md and ./SESSION_TODOS.md if needed (first run node scripts/show-est-time.js to get current time) and then update them if you feel you have some useful info to add to them at this point. And update CHANGELOG.md when appropriate. And read or write any other .md files in the root/zdocs[/*] directory when it might provide helpful context."

# --- CHECK POWER SETTINGS ONLY ---
if [[ "$1" == "--check-power" ]]; then
  echo "🔍 Current xset power/sleep configuration:"
  xset q | grep -A 5 "DPMS"
  echo ""
  echo "🍏 Screensaver settings:"
  xset q | grep "timeout"
  exit 0
fi

# --- GLOBAL STATE ---
ORIGINAL_DPMS=$(xset -q | grep 'DPMS is' | awk '{print $3}')
ORIGINAL_TIMEOUTS=$(xset -q | grep -A 1 "DPMS" | grep -Eo '[0-9]+' | tr '\n' ' ')
ORIGINAL_SCREENSAVER=$(xset q | grep "timeout:" | awk '{print $2, $4}')

INT_COUNT=0
SHOULD_EXIT_LOOP=false

trap 'handle_interrupt' SIGINT

# --- FUNCTIONS ---
function handle_interrupt() {
  ((INT_COUNT++))
  if (( INT_COUNT == 1 )); then
    echo -e "\n🛑 Ctrl+C detected. Countdown paused. Press Ctrl+C again to save logs and exit."
    SHOULD_EXIT_LOOP=true
  else
    echo -e "\n📝 Second Ctrl+C received. Saving logs and exiting..."
    kill "$AUTOSAVE_PID" 2>/dev/null
    # save_tmux_history
    restore_sleep
    stty sane
    exit 0
  fi
}

function countdown() {
  local seconds=$1
  echo "🕒 Countdown started. Press any key to pause/resume."
  local paused=false

  while (( seconds > 0 )); do
    if [[ "$SHOULD_EXIT_LOOP" == true ]]; then break; fi

    if [[ "$paused" == false ]]; then
      printf "\r⏳ Time remaining: %02d:%02d:%02d " $((seconds/3600)) $(((seconds%3600)/60)) $((seconds%60))
      ((seconds--))
    fi

    # Non-blocking keypress check
    if read -rsn1 -t 1 key; then
      if [[ "$paused" == false ]]; then
        echo -e "\n⏸️ Paused. Press any key to resume."
        paused=true
      else
        echo "▶️ Resuming Claude loop countdown."
        paused=false
      fi
    fi
  done
  echo ""
}


function disable_sleep() {
  echo "🔒 Disabling screen blanking and sleep..."
  xset s off
  xset -dpms
  xset s noblank
  systemd-inhibit --what=sleep --who="Claude Auto Loop" --why="Running scheduled loop" sleep 1 &
  INHIBIT_PID=$!
}

function restore_sleep() {
  echo -e "\n♻️ Restoring previous screen and sleep settings..."
  [[ "$ORIGINAL_DPMS" == "enabled" ]] && xset +dpms || xset -dpms

  read -r standby suspend off <<< "$ORIGINAL_TIMEOUTS"
  [[ -z "$off" ]] && off=600
  if [[ "$standby" =~ ^[0-9]+$ && "$suspend" =~ ^[0-9]+$ && "$off" =~ ^[0-9]+$ ]]; then
    xset dpms "$standby" "$suspend" "$off"
  fi

  read -r s_timeout s_cycle <<< "$ORIGINAL_SCREENSAVER"
  if [[ "$s_timeout" =~ ^[0-9]+$ && "$s_cycle" =~ ^[0-9]+$ ]]; then
    xset s "$s_timeout" "$s_cycle"
  fi

  [[ -n "$INHIBIT_PID" ]] && kill "$INHIBIT_PID" 2>/dev/null
  stty sane
}

function wait_until_start_time() {
  echo "⏱ Waiting until $START_TIME to begin message loop..."
  now_epoch=$(date +%s)
  start_epoch=$(date -d "$(date +%Y-%m-%d) $START_TIME" +%s)
  (( start_epoch <= now_epoch )) && start_epoch=$(date -d "tomorrow $START_TIME" +%s)
  countdown $((start_epoch - now_epoch))
}

function launch_tmux_session_in_new_window() {
  local terminal_cmd=""
  if command -v gnome-terminal >/dev/null 2>&1; then
    terminal_cmd="gnome-terminal"
  elif command -v xfce4-terminal >/dev/null 2>&1; then
    terminal_cmd="xfce4-terminal"
  elif command -v xterm >/dev/null 2>&1; then
    terminal_cmd="xterm"
  else
    echo "⚠️ No supported terminal emulator found. Launching in background instead."
    tmux new-session -d -s "$SESSION_NAME" 'claude'
    sleep 2
    return
  fi

  echo "🚀 Launching Claude in new terminal window..."
  $terminal_cmd -- bash -c "tmux new-session -s '$SESSION_NAME' 'claude'"
  sleep 4
}

function check_or_start_tmux_session() {
  if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "⚠️ Tmux session '$SESSION_NAME' already exists."
    echo "[C] Continue using existing"
    echo "[K] Kill session and start fresh"
    echo "[Q] Quit"
    read -rp "Enter your choice [C/K/Q]: " choice
    case "$choice" in
      [Cc])
        echo "✅ Using existing session."
        return
        ;;
      [Kk])
        tmux kill-session -t "$SESSION_NAME"
        echo "✅ Killed session. Restarting..."
        ;;
      [Qq])
        echo "❌ Aborted."
        exit 1
        ;;
      *)
        echo "❌ Invalid choice. Aborting."
        exit 1
        ;;
    esac
  fi

  launch_tmux_session_in_new_window
  # These keys are needed to connect the session to the vs Code. And there needs to be some kind of pause between each keypress so that the keypresses get entered in the right context.
  sleep 2
  tmux send-keys -t "$SESSION_NAME" '/ide'
  sleep 0.5
  tmux send-keys -t "$SESSION_NAME" Enter
  sleep 1.5
  tmux send-keys -t "$SESSION_NAME" Up 
  sleep 0.5
  tmux send-keys -t "$SESSION_NAME" Enter
}

function save_tmux_history() {
  echo -e "\n📝 Saving Claude session output..."
  local capture_output
  capture_output=$(tmux capture-pane -pt "$SESSION_NAME" -S -10000 2>/dev/null)
  
  # Update final log filename with current time
  local final_time=$(date +%H-%M-%S)
  LOGFILE="$LOG_DIR/claude_${CURRENT_DATE}_${final_time}_final.txt"

  if [[ -z "$capture_output" ]]; then
    echo "⚠️ Claude session closed. Using last autosave."
    if [[ -f "$AUTOSAVE_FILE" ]]; then
      cp "$AUTOSAVE_FILE" "$LOGFILE"
    fi
    return
  fi

  echo "$capture_output" > "$LOGFILE"
  echo "✅ Final log saved to $LOGFILE"

  # Clean up current autosave since we have the final log
  if [[ -f "$AUTOSAVE_FILE" ]]; then
    rm "$AUTOSAVE_FILE"
    echo "🧹 Removed autosave file"
  fi
}

function rotate_log_if_needed() {
  local new_date=$(date +%F)
  local file_size=0
  
  # Check if file exists and get its size
  if [[ -f "$AUTOSAVE_FILE" ]]; then
    file_size=$(stat -c%s "$AUTOSAVE_FILE" 2>/dev/null || echo 0)
  fi
  
  # Rotate if date changed or file is too large
  if [[ "$new_date" != "$CURRENT_DATE" ]] || [[ $file_size -gt $MAX_LOG_SIZE ]]; then
    echo "📁 Rotating log (date changed or size limit reached)..."
    
    # Save current autosave as final log
    if [[ -f "$AUTOSAVE_FILE" && $file_size -gt 0 ]]; then
      local rotate_time=$(date +%H-%M-%S)
      local rotated_file="$LOG_DIR/claude_${CURRENT_DATE}_${rotate_time}_rotated.txt"
      mv "$AUTOSAVE_FILE" "$rotated_file"
      echo "✅ Rotated log to: $rotated_file"
    fi
    
    # Update current date and file names
    CURRENT_DATE="$new_date"
    AUTOSAVE_FILE="$LOG_DIR/claude_${CURRENT_DATE}_current.txt"
    
    # Create new autosave file with minimal overlap
    # Get last 50 lines from tmux to provide context continuity
    tmux capture-pane -pt "$SESSION_NAME" -S -50 > "$AUTOSAVE_FILE" 2>/dev/null
  fi
}

function start_tmux_autosave_loop() {
  echo "♻️ Starting tmux autosave loop every $AUTOSAVE_INTERVAL seconds..."
  while true; do
    rotate_log_if_needed
    
    # Capture full history to autosave
    local new_content=$(tmux capture-pane -pt "$SESSION_NAME" -S -10000 2>/dev/null)
    
    if [[ -n "$new_content" ]]; then
      echo "$new_content" > "$AUTOSAVE_FILE"
    fi
    
    sleep "$AUTOSAVE_INTERVAL"
  done
}

# --- MAIN ---
check_or_start_tmux_session
disable_sleep

start_tmux_autosave_loop &
AUTOSAVE_PID=$!

if [ "$USE_START_TIME" = true ]; then
  wait_until_start_time
else
  echo "⏳ Skipping start time wait. Starting loop now."
fi

echo "[$(date)] 🚀 Claude auto-continue started"
echo "Will send every $DELAY_MINUTES min. Ctrl+C = pause, Ctrl+C again = exit"

while true; do
  if [[ "$SHOULD_EXIT_LOOP" == true ]]; then
    sleep 1
    continue
  fi
  tmux send-keys -t "$SESSION_NAME" "$MESSAGE"
  sleep 0.4
  tmux send-keys -t "$SESSION_NAME"  Enter
  echo "[$(date)] ✅ Sent message"
  countdown $((DELAY_MINUTES * 60))
done
