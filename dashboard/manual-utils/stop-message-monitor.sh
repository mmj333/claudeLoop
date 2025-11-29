#!/bin/bash

# Claude Message Monitor Stop Script

PID_FILE="/tmp/claude-monitors/message-monitor.pid"

if [ ! -f "$PID_FILE" ]; then
    echo "Message monitor not running (no PID file found)"
    exit 0
fi

PID=$(cat "$PID_FILE")

if ps -p "$PID" > /dev/null 2>&1; then
    echo "Stopping message monitor (PID: $PID)..."
    kill "$PID"
    rm -f "$PID_FILE"
    echo "✅ Message monitor stopped"
else
    echo "Message monitor not running (process not found)"
    rm -f "$PID_FILE"
fi