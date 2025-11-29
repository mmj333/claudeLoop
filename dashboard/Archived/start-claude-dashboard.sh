#!/bin/bash

# Start Claude Loop Dashboard
# This script starts the dashboard and opens it in your browser

echo "Starting Claude Loop Dashboard..."

# Kill any existing dashboard process
pkill -f "claude-loop-dashboard-simple.js" 2>/dev/null

# Start the dashboard
cd /home/michael/InfiniQuest
nohup node tmp/claudeLoop/dashboard/claude-loop-dashboard-simple.js > /tmp/claude-dashboard.log 2>&1 &

# Wait a moment for it to start
sleep 2

# Open in browser
if command -v xdg-open > /dev/null; then
    xdg-open http://localhost:3333
elif command -v open > /dev/null; then
    open http://localhost:3333
else
    echo "Dashboard running at: http://localhost:3333"
fi

echo "Dashboard started! Check http://localhost:3333"
echo "To stop: pkill -f claude-loop-dashboard-simple.js"