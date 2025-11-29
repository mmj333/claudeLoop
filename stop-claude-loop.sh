#!/bin/bash

# Script to properly stop a claude loop instance with lock file cleanup

INSTANCE_NAME="${1:-claude-loop1}"
LOCK_FILE="/tmp/claude_loop_${INSTANCE_NAME}.lock"
PID_FILE="/tmp/claude_loop_${INSTANCE_NAME}.pid"
PAUSE_FILE="/tmp/claude_loop_${INSTANCE_NAME}_paused"
RESUME_TIME_FILE="/tmp/claude_loop_${INSTANCE_NAME}_resume_time"

echo "🛑 Stopping claude loop instance: $INSTANCE_NAME"

# Check if PID file exists
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE" 2>/dev/null)
    if [ -n "$PID" ]; then
        # Check if process is running
        if ps -p "$PID" > /dev/null 2>&1; then
            echo "   Killing process $PID..."
            kill "$PID" 2>/dev/null
            
            # Give it a moment to clean up gracefully
            sleep 2
            
            # Force kill if still running
            if ps -p "$PID" > /dev/null 2>&1; then
                echo "   Force killing process $PID..."
                kill -9 "$PID" 2>/dev/null
            fi
        else
            echo "   Process $PID is not running"
        fi
    fi
fi

# Clean up all related files
echo "   Cleaning up files..."
rm -f "$LOCK_FILE" "$PID_FILE" "$PAUSE_FILE" "$RESUME_TIME_FILE"

# NOTE: We do NOT stop log monitors here - they should run independently of loops
# Log monitors capture tmux session output and should continue even when loops are stopped

echo "✅ Claude loop instance '$INSTANCE_NAME' stopped and cleaned up"