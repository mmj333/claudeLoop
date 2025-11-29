#!/bin/bash

# Universal Claude Loop Dashboard Starter
echo "🎮 Starting Claude Loop Dashboard..."

# Kill any existing dashboards
pkill -f "claude-loop-dashboard.*\.js" 2>/dev/null

# Start the unified dashboard (the one to rule them all)
cd /home/michael/InfiniQuest
nohup node tmp/claudeLoop/dashboard/claude-loop-unified-dashboard.js > /tmp/claude-dashboard.log 2>&1 &

# Wait for startup
sleep 2

# Open in browser
if command -v xdg-open > /dev/null; then
    xdg-open http://localhost:3335
elif command -v open > /dev/null; then
    open http://localhost:3335
else
    echo "Dashboard running at: http://localhost:3335"
fi

echo "✅ Dashboard started at http://localhost:3335"
echo ""
echo "Features:"
echo "  📊 Real-time context monitoring"
echo "  ⚙️  Adjustable delay, thresholds, scheduling"
echo "  💬 Custom messages (change anytime)"
echo "  🎮 Full loop control without restarts"
echo "  💾 Persistent configuration"
echo ""
echo "To stop: pkill -f claude-loop-unified-dashboard.js"