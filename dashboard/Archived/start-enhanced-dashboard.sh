#!/bin/bash

# Start Enhanced Claude Loop Dashboard
echo "Starting Enhanced Claude Loop Dashboard..."

# Kill any existing enhanced dashboard
pkill -f "claude-loop-dashboard-enhanced.js" 2>/dev/null

# Start the enhanced dashboard
cd /home/michael/InfiniQuest
nohup node tmp/claudeLoop/dashboard/claude-loop-dashboard-enhanced.js > /tmp/claude-enhanced-dashboard.log 2>&1 &

# Wait for startup
sleep 2

# Open in browser
if command -v xdg-open > /dev/null; then
    xdg-open http://localhost:3334
elif command -v open > /dev/null; then
    open http://localhost:3334
else
    echo "Enhanced dashboard running at: http://localhost:3334"
fi

echo "✅ Enhanced dashboard started at http://localhost:3334"
echo "📊 Features: Context monitoring, Custom messages, Loop control"
echo "To stop: pkill -f claude-loop-dashboard-enhanced.js"