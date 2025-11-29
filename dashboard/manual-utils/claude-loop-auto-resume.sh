#!/bin/bash

# Auto-Resume Manager for Claude Loop
# Monitors the resume time and automatically removes pause file when time is reached

PAUSE_FILE="/tmp/claude_loop_paused"
RESUME_TIME_FILE="/tmp/claude_loop_resume_time"

echo "🔄 Claude Loop Auto-Resume Manager Started"
echo "   Monitoring for scheduled resume times..."

while true; do
  if [[ -f "$PAUSE_FILE" && -f "$RESUME_TIME_FILE" ]]; then
    # Read the resume time
    resume_time_iso=$(cat "$RESUME_TIME_FILE")
    
    # Convert to timestamp for comparison
    resume_timestamp=$(date -d "$resume_time_iso" +%s 2>/dev/null)
    current_timestamp=$(date +%s)
    
    if [[ -n "$resume_timestamp" ]]; then
      resume_formatted=$(date -d "$resume_time_iso" "+%I:%M %p")
      
      if [[ $current_timestamp -ge $resume_timestamp ]]; then
        # Time to resume!
        echo ""
        echo "⏰ Resume time reached! ($resume_formatted)"
        echo "   Removing pause file..."
        
        rm -f "$PAUSE_FILE"
        rm -f "$RESUME_TIME_FILE"
        
        echo "✅ Loop resumed automatically"
      else
        # Still waiting
        seconds_left=$((resume_timestamp - current_timestamp))
        hours=$((seconds_left / 3600))
        minutes=$(((seconds_left % 3600) / 60))
        
        printf "\r⏳ Waiting to resume at %s (in %02d:%02d)..." "$resume_formatted" "$hours" "$minutes"
      fi
    fi
  fi
  
  sleep 30
done