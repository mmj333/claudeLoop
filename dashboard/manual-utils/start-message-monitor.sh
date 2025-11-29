#!/bin/bash

# Claude Message Monitor Launcher

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONITOR_SCRIPT="$(dirname "$SCRIPT_DIR")/claude-message-monitor.js"
PID_FILE="/tmp/claude-monitors/message-monitor.pid"
LOG_FILE="/tmp/claude-monitors/message-monitor.log"

# Ensure directories exist
mkdir -p /tmp/claude-monitors

# Check if already running
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if ps -p "$OLD_PID" > /dev/null 2>&1; then
        echo "Message monitor already running (PID: $OLD_PID)"
        echo "Status available at: http://localhost:3458/status"
        exit 0
    else
        echo "Removing stale PID file"
        rm -f "$PID_FILE"
    fi
fi

# Start the monitor
echo "Starting Claude Message Monitor..."
nohup node "$MONITOR_SCRIPT" > "$LOG_FILE" 2>&1 &
PID=$!

# Save PID
echo $PID > "$PID_FILE"

echo "✅ Message monitor started (PID: $PID)"
echo "📊 Status endpoint: http://localhost:3458/status"
echo "📝 Log file: $LOG_FILE"

# Show initial log output
sleep 1
tail -10 "$LOG_FILE"