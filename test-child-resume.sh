#!/bin/bash

# Test script to convert child conversations to resumable format
# Theory: Maybe Claude just blocks resuming known children

CHILD_ID="1af7cc50-9380-4972-88f4-c4691b9c77d6"
CLAUDE_DIR="$HOME/.claude/projects/-home-michael-InfiniQuest"

echo "Testing child conversation resume theory"
echo "========================================"
echo ""

# Test 1: Try to resume the original child directly
echo "Test 1: Can we resume the original child file?"
echo "Running: claude --resume $CHILD_ID"
echo "(This should fail with 'No messages returned' or similar)"
echo ""
timeout 2 claude --resume "$CHILD_ID" 2>&1 | head -5
echo ""

# Test 2: Copy to new UUID, update sessionIds
NEW_UUID=$(uuidgen)
NEW_FILE="$CLAUDE_DIR/$NEW_UUID.jsonl"

echo "Test 2: Copy child to new UUID and update sessionIds"
echo "New UUID: $NEW_UUID"
echo ""

# Copy and update sessionIds in one step
sed "s/\"sessionId\":\"[^\"]*\"/\"sessionId\":\"$NEW_UUID\"/g" \
    "$CLAUDE_DIR/$CHILD_ID.jsonl" > "$NEW_FILE"

echo "Created: $NEW_FILE"
echo "SessionIds updated to match new filename"
echo ""

# Show what we changed
echo "Sample of changes made:"
echo "First 5 sessionIds in new file:"
grep -o '"sessionId":"[^"]*"' "$NEW_FILE" | head -5
echo ""

# Test resuming the new file
echo "Test 3: Try to resume the converted file"
echo "Running: claude --resume $NEW_UUID"
echo "(If this works, it proves Claude can resume children with correct sessionIds)"
echo ""
echo "Type 'exit' to quit the test session"
echo ""

# Run the resume command
claude --resume "$NEW_UUID"

# Cleanup
echo ""
echo "Cleaning up test file..."
rm -f "$NEW_FILE"
echo "Done!"