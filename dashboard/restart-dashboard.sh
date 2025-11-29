#!/bin/bash

# Restart Claude Loop Dashboard v1
# Kills any existing v1 instance and starts fresh

echo "🔄 Restarting Claude Loop Dashboard v1..."

# Run Claude Code corruption check/repair
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/claude-repair.sh" ]; then
    echo "🔍 Running Claude Code health check..."
    # Run interactively so user can see prompt and press D for deep scan
    # (Output is also logged to /tmp/claude-repair.log by the script itself)
    bash "$SCRIPT_DIR/claude-repair.sh"
    echo ""
fi

# Kill any existing dashboard v1 instances only
# Look for processes in the dashboard directory specifically (not dashboard-v2)
pkill -f "dashboard/claude-loop-unified-dashboard.js" 2>/dev/null

# Give processes a moment to exit gracefully
sleep 1

# Force kill any remaining v1 processes
pkill -9 -f "dashboard/claude-loop-unified-dashboard.js" 2>/dev/null

# Also check by port in case process name doesn't match (with timeout to prevent hanging)
# Note: v1 runs on port 3335
timeout 2 lsof -ti:3335 2>/dev/null | xargs -r kill -9 2>/dev/null

# Final verification - list any remaining v1 processes
remaining=$(pgrep -f "dashboard/claude-loop-unified-dashboard.js" | wc -l)
if [ "$remaining" -gt 0 ]; then
    echo "⚠️  Warning: Found $remaining dashboard v1 process(es) still running"
    echo "Force killing PIDs: $(pgrep -f 'dashboard/claude-loop-unified-dashboard.js')"
    pgrep -f "dashboard/claude-loop-unified-dashboard.js" | xargs -r kill -9
fi

sleep 1

# Change to project directory
cd /home/michael/InfiniQuest

# Clear the log file for fresh start
> /tmp/claude-dashboard.log

# Start the dashboard
nohup node tmp/claudeLoop/dashboard/claude-loop-unified-dashboard.js > /tmp/claude-dashboard.log 2>&1 &
NEW_PID=$!

# Wait for it to start
sleep 2

# Check if it started successfully
if kill -0 $NEW_PID 2>/dev/null; then
    # Check if the port is actually listening
    if lsof -i:3335 >/dev/null 2>&1; then
        echo "✅ Dashboard v1 restarted successfully! (PID: $NEW_PID)"
        echo "📍 Access at: http://192.168.1.2:3335"
        echo "📄 Logs: tail -f /tmp/claude-dashboard.log"
    else
        echo "⚠️  Process started but not listening on port 3335 yet"
        echo "Check logs: tail -f /tmp/claude-dashboard.log"
    fi
else
    echo "❌ Failed to start dashboard v1"
    echo "Check logs: cat /tmp/claude-dashboard.log"
    exit 1
fi