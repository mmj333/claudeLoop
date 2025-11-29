#!/bin/bash

# Archive old dashboard files while keeping active ones

ARCHIVE_DIR="/home/michael/InfiniQuest/tmp/claudeLoop/dashboard/Archived/dashboard-$(date +%Y%m%d)"
mkdir -p "$ARCHIVE_DIR"

echo "📦 Archiving old dashboard files..."
echo ""

# Archive old monitor versions
echo "Moving old monitor versions..."
mv claude-loop-monitor-idle-aware.js "$ARCHIVE_DIR/" 2>/dev/null
mv claude-loop-monitor-user-idle.js "$ARCHIVE_DIR/" 2>/dev/null
mv claude-loop-monitor-user-idle.js.backup-* "$ARCHIVE_DIR/" 2>/dev/null
mv monitor-config-example.json "$ARCHIVE_DIR/" 2>/dev/null

# Archive test/verification scripts that were for development
echo "Moving development/test scripts..."
mv test-idle-monitor.js "$ARCHIVE_DIR/" 2>/dev/null
mv update-idle-config.js "$ARCHIVE_DIR/" 2>/dev/null
mv verify-idle-setup.sh "$ARCHIVE_DIR/" 2>/dev/null

# Check for any backup files
echo "Moving backup files..."
mv *.backup-* "$ARCHIVE_DIR/" 2>/dev/null

echo ""
echo "✅ Active dashboard components:"
echo ""
echo "🎮 Main Dashboard:"
echo "   • claude-loop-unified-dashboard.js (main dashboard)"
echo "   • restart.sh / stop.sh (dashboard control)"
echo ""
echo "📝 Log Monitors:"
echo "   • log-monitor.sh (efficient shell version)"
echo "   • log-monitor-idle.sh (launcher script)"
echo "   • log-monitor-manager.sh (orchestrator)"
echo ""
echo "💬 Message Detection:"
echo "   • claude-message-monitor.js (context/message checker)"
echo "   • start-message-monitor.sh / stop-message-monitor.sh"
echo ""
echo "🤖 Claude Session Management:"
echo "   • tmux-claude-setup.sh (session setup)"
echo "   • claude-loop-auto-resume.sh (auto-resume)"
echo "   • cleanup-loops.sh (cleanup utility)"
echo ""
echo "📁 Archived to: $ARCHIVE_DIR"
echo ""
echo "📋 Files remaining in dashboard folder:"
ls -la /home/michael/InfiniQuest/tmp/claudeLoop/dashboard/ | grep -v "^d" | grep -v "^total" | wc -l
echo ""
echo "Run 'ls -la /home/michael/InfiniQuest/tmp/claudeLoop/dashboard/' to see details"