#!/bin/bash

echo "🧹 Cleaning up duplicate Claude loop processes..."

# Find all claude loop processes except the cleanup script itself
PIDS=$(ps aux | grep -E "claude.*loop|claude-loop" | grep -v grep | grep -v cleanup-loops | awk '{print $2}')

if [ -z "$PIDS" ]; then
    echo "✅ No Claude loop processes found"
    exit 0
fi

echo "Found the following processes:"
ps aux | grep -E "claude.*loop|claude-loop" | grep -v grep | grep -v cleanup-loops

echo ""
echo "⚠️  This will kill ALL Claude loop processes!"
read -p "Continue? (y/n) " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    for PID in $PIDS; do
        echo "Killing PID $PID..."
        kill -9 $PID 2>/dev/null
    done
    echo "✅ All processes killed"
    
    # Also clean up any stale lock files
    rm -f /tmp/claude-loop*.lock 2>/dev/null
    rm -f /tmp/claude-monitor*.pid 2>/dev/null
    
    echo "🧹 Cleaned up lock/pid files"
else
    echo "❌ Cancelled"
fi