#!/bin/bash

# Claude Loop with Context Awareness
# - Monitors context usage and sends special messages when low
# - Supports custom commands
# - Smart context management

cd ~/InfiniQuest

# --- CONFIGURATION ---
SESSION_NAME="claude"
DELAY_MINUTES=10
LOG_DIR=~/InfiniQuest/tmp/claudeLogs
mkdir -p "$LOG_DIR"

# Context thresholds
CONTEXT_WARNING_PERCENT=20  # Warn when below 20%
CONTEXT_CRITICAL_PERCENT=10 # Critical when below 10%

# Default messages
DEFAULT_MESSAGE="Please continue -- Further context: read end of tmp/claudeLogs/claude_YYYY_MM_DD_current.txt and/or end of latest and/or end of 2nd latest: tmp/claudeLogs file and latest or relevant tmp/trace_logs file."

CONTEXT_WARNING_MESSAGE="Context is running low (below ${CONTEXT_WARNING_PERCENT}%). Please prepare to /compact soon. Continue with current work but be ready to summarize."

CONTEXT_CRITICAL_MESSAGE="/compact - Context critically low. Please compact the conversation and provide a summary of current work and next steps."

# Custom message override
CUSTOM_MESSAGE="${1:-$DEFAULT_MESSAGE}"

# Monitor files
PAUSE_FILE="/tmp/claude_loop_paused"
CONTEXT_STATE_FILE="/tmp/claude_context_state.json"
MONITOR_PID=""

# --- FUNCTIONS ---
function estimate_context_usage() {
  # Use the actual Claude log file for accurate estimation
  local current_log="$LOG_DIR/claude_$(date +%Y-%m-%d)_current.txt"
  
  if [[ -f "$current_log" ]]; then
    local log_size=$(stat -f%z "$current_log" 2>/dev/null || stat -c%s "$current_log" 2>/dev/null)
    
    # Claude's context is approximately 200k tokens
    # Rough estimate: 1 token ≈ 4 bytes, so 200k tokens ≈ 800KB
    local max_context_bytes=800000
    
    # Look for context indicators in the log
    local compact_count=$(grep -c "/compact" "$current_log" 2>/dev/null || echo 0)
    local last_compact_line=$(grep -n "/compact" "$current_log" 2>/dev/null | tail -1 | cut -d: -f1)
    
    if [[ -n "$last_compact_line" ]]; then
      # Count only bytes after the last compact
      local total_lines=$(wc -l < "$current_log")
      local lines_after_compact=$((total_lines - last_compact_line))
      # Estimate bytes after compact (avg 100 bytes per line)
      local used_bytes=$((lines_after_compact * 100))
    else
      # No compact found, use total size
      local used_bytes=$log_size
    fi
    
    # Calculate percentage
    local percent_used=$((used_bytes * 100 / max_context_bytes))
    local percent_remaining=$((100 - percent_used))
    
    # Ensure it's between 0 and 100
    if (( percent_remaining < 0 )); then
      percent_remaining=0
    elif (( percent_remaining > 100 )); then
      percent_remaining=100
    fi
    
    echo "$percent_remaining"
  else
    echo "100"  # Assume full context if no log found
  fi
}

function get_context_message() {
  local context_percent=$(estimate_context_usage)
  
  # Save state for dashboard
  echo "{\"contextPercent\": $context_percent, \"timestamp\": \"$(date -Iseconds)\"}" > "$CONTEXT_STATE_FILE"
  
  if (( context_percent <= CONTEXT_CRITICAL_PERCENT )); then
    echo "$CONTEXT_CRITICAL_MESSAGE"
  elif (( context_percent <= CONTEXT_WARNING_PERCENT )); then
    echo "$CONTEXT_WARNING_MESSAGE"
  else
    echo "$CUSTOM_MESSAGE"
  fi
}

function send_to_claude() {
  # First try to get message from dashboard API
  local api_message=""
  if curl -s "http://localhost:3456/api/next-message?session=${SESSION_NAME}" > /tmp/claude_next_message.txt 2>/dev/null; then
    api_message=$(cat /tmp/claude_next_message.txt)
  fi
  
  # Use API message if available, otherwise fall back to context-based message
  local message
  if [[ -n "$api_message" && "$api_message" != "null" && "$api_message" != "" ]]; then
    message="$api_message"
    echo "📨 Using conditional message from dashboard"
  else
    message=$(get_context_message)
    echo "📨 Using context-based message"
  fi
  
  local context_percent=$(estimate_context_usage)
  
  echo "📊 Context remaining: ~${context_percent}%"
  echo "📨 Sending: $message"
  
  # Send to tmux session
  tmux send-keys -t "$SESSION_NAME" "$message" Enter
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

function wait_for_resume() {
  while [[ -f "$PAUSE_FILE" ]]; do
    echo -e "\r⏸️  Loop paused. Remove $PAUSE_FILE to resume..."
    sleep 5
  done
}

function cleanup() {
  echo -e "\n🧹 Cleaning up..."
  rm -f "$CONTEXT_STATE_FILE"
  exit 0
}

trap cleanup EXIT INT TERM

# --- MAIN LOOP ---
echo "🤖 Claude Context-Aware Loop Starting..."
echo "📊 Context thresholds: Warning at ${CONTEXT_WARNING_PERCENT}%, Critical at ${CONTEXT_CRITICAL_PERCENT}%"
echo "💬 Custom message: ${CUSTOM_MESSAGE:0:50}..."

check_or_start_tmux_session

while true; do
  wait_for_resume
  
  # Send appropriate message based on context
  send_to_claude
  
  # Wait before next iteration
  echo "⏳ Waiting ${DELAY_MINUTES} minutes..."
  sleep $((DELAY_MINUTES * 60))
done