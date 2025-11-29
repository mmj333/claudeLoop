#!/bin/bash

# Archive unused dashboard files
# Based on dependency analysis

echo "📦 Archiving unused dashboard files..."

# Ensure Archived directory exists
mkdir -p Archived

# Archive old dashboard versions
echo "Moving old dashboard versions..."
mv claude-loop-monitor-fixed.js Archived/ 2>/dev/null
mv claude-loop-monitor-improved.js Archived/ 2>/dev/null
mv start-claude-dashboard.sh Archived/ 2>/dev/null
mv start-dashboard.sh Archived/ 2>/dev/null  
mv start-enhanced-dashboard.sh Archived/ 2>/dev/null

# Archive test/analysis scripts
echo "Moving test and analysis scripts..."
mv analyze-ansi-patterns.js Archived/ 2>/dev/null
mv test-ansi-comparison.js Archived/ 2>/dev/null
mv test-ansi-detailed.js Archived/ 2>/dev/null
mv test-ansi-vs-html.js Archived/ 2>/dev/null
mv test-persistence.js Archived/ 2>/dev/null
mv test-settings.sh Archived/ 2>/dev/null

# Note: keeping cleanup-loops.sh as emergency reset tool

echo "✅ Archiving complete!"
echo ""
echo "Files remaining in dashboard directory:"
ls -la | grep -v "^d" | grep -v "^total"