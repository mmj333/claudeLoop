#!/bin/bash

# Migrate old autosave_claude.txt to new naming format
LOG_DIR=~/InfiniQuest/tmp/claudeLogs
OLD_AUTOSAVE="$LOG_DIR/autosave_claude.txt"
NEW_AUTOSAVE="$LOG_DIR/claude_$(date +%F)_current.txt"

if [[ -f "$OLD_AUTOSAVE" ]]; then
    echo "🔄 Migrating old autosave file to new format..."
    mv "$OLD_AUTOSAVE" "$NEW_AUTOSAVE"
    echo "✅ Migrated: $OLD_AUTOSAVE → $NEW_AUTOSAVE"
else
    echo "ℹ️ No old autosave file found to migrate"
fi

echo "📊 Current log files:"
ls -la "$LOG_DIR" | grep -E "(current|autosave)" | head -10