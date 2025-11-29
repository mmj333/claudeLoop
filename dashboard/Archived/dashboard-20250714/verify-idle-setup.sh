#!/bin/bash

# Verification script for idle-aware monitor setup

echo "🔍 Verifying Idle-Aware Monitor Setup"
echo "====================================="
echo ""

# Check if new monitor exists
if [ -f "tmp/claudeLoop/dashboard/claude-loop-monitor-idle-aware.js" ]; then
    echo "✅ Idle-aware monitor script exists"
else
    echo "❌ Idle-aware monitor script not found!"
    exit 1
fi

# Check if it's executable
if [ -x "tmp/claudeLoop/dashboard/claude-loop-monitor-idle-aware.js" ]; then
    echo "✅ Monitor script is executable"
else
    echo "❌ Monitor script is not executable"
fi

# Check if loop script is updated
if grep -q "claude-loop-monitor-idle-aware.js" tmp/claudeLoop/claude-loop-enhanced-v2.sh; then
    echo "✅ Loop script updated to use new monitor"
else
    echo "❌ Loop script still using old monitor"
fi

# Check config for idle settings
SESSION_NAME="${1:-claude-loop1}"
CONFIG_FILE="tmp/claudeLoop/dashboard/loop-config-${SESSION_NAME}.json"

if [ -f "$CONFIG_FILE" ]; then
    if grep -q "monitorSettings" "$CONFIG_FILE"; then
        echo "✅ Config has idle settings for $SESSION_NAME"
        echo ""
        echo "📋 Current idle configuration:"
        jq '.monitorSettings' "$CONFIG_FILE" 2>/dev/null || echo "   (Install jq to see formatted config)"
    else
        echo "⚠️  Config missing idle settings - run: node tmp/claudeLoop/dashboard/update-idle-config.js $SESSION_NAME"
    fi
else
    echo "❌ Config file not found for session: $SESSION_NAME"
fi

echo ""
echo "🧪 To test the monitor:"
echo "   1. Run: node tmp/claudeLoop/dashboard/test-idle-monitor.js $SESSION_NAME"
echo "   2. Or restart your loop normally and watch the logs"
echo ""
echo "📊 Monitor behavior:"
echo "   - Active: 1s refresh (when typing or CPU > 10%)"
echo "   - Idle: 5s refresh (after 2 min inactivity)"
echo "   - Very Idle: 30s refresh (after 6 min inactivity)"
echo ""
echo "🔍 To check current idle state:"
echo "   cat /tmp/claude_loop_idle_state.json | jq ."