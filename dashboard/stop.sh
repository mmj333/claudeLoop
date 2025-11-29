#!/bin/bash

# Stop Claude Loop Dashboard

echo "⏹️  Stopping Claude Loop Dashboard..."

# Kill the dashboard process
if pkill -f "claude-loop-unified-dashboard.js"; then
    echo "✅ Dashboard stopped successfully"
else
    echo "⚠️  No dashboard process found"
fi

# Optional: Also stop any active Claude loops
read -p "Also stop active Claude loops? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "Stopping Claude loops..."
    pkill -f "claude-loop.*\.sh" 2>/dev/null
    rm -f /tmp/claude_loop.pid 2>/dev/null
    echo "✅ Claude loops stopped"
fi