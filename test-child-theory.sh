#!/bin/bash

# Non-interactive test to check if Claude blocks child conversations
# Theory: Maybe Claude maintains a list of known child UUIDs and blocks them

CHILD_ID="1af7cc50-9380-4972-88f4-c4691b9c77d6"
CLAUDE_DIR="$HOME/.claude/projects/-home-michael-InfiniQuest"

echo "Testing Claude's child conversation blocking theory"
echo "==================================================="
echo ""

# Function to test resume with timeout
test_resume() {
    local uuid=$1
    local description=$2
    
    echo "Testing: $description"
    echo "UUID: $uuid"
    
    # Try to resume with a short timeout and capture result
    result=$(timeout 2 echo "exit" | claude --resume "$uuid" 2>&1)
    
    if echo "$result" | grep -q "No messages returned"; then
        echo "Result: ❌ Failed - 'No messages returned'"
    elif echo "$result" | grep -q "Welcome back"; then
        echo "Result: ✅ Success - Got welcome message"
    elif echo "$result" | grep -q "conversation not found"; then
        echo "Result: ❌ Failed - Conversation not found"
    else
        echo "Result: 🤔 Unknown - Check output below:"
        echo "$result" | head -3
    fi
    echo ""
}

# Test 1: Original child
test_resume "$CHILD_ID" "Original child conversation"

# Test 2: Same structure, new UUID
NEW_UUID1=$(uuidgen)
cp "$CLAUDE_DIR/$CHILD_ID.jsonl" "$CLAUDE_DIR/$NEW_UUID1.jsonl"
sed -i "s/\"sessionId\":\"[^\"]*\"/\"sessionId\":\"$NEW_UUID1\"/g" "$CLAUDE_DIR/$NEW_UUID1.jsonl"
test_resume "$NEW_UUID1" "Child copied to new UUID with updated sessionIds"
rm -f "$CLAUDE_DIR/$NEW_UUID1.jsonl"

# Test 3: Check if it's about the parentUuid field
NEW_UUID2=$(uuidgen)
# Copy and remove parentUuid references
sed -e "s/\"sessionId\":\"[^\"]*\"/\"sessionId\":\"$NEW_UUID2\"/g" \
    -e 's/"parentUuid":"[^"]*"/"parentUuid":null/g' \
    "$CLAUDE_DIR/$CHILD_ID.jsonl" > "$CLAUDE_DIR/$NEW_UUID2.jsonl"
test_resume "$NEW_UUID2" "Child with parentUuid set to null"
rm -f "$CLAUDE_DIR/$NEW_UUID2.jsonl"

# Test 4: What if we use a completely random UUID that never existed?
RANDOM_UUID=$(uuidgen)
echo "Testing: Non-existent conversation"
echo "UUID: $RANDOM_UUID"
result=$(timeout 2 echo "exit" | claude --resume "$RANDOM_UUID" 2>&1)
if echo "$result" | grep -q "conversation not found\|No messages\|not found"; then
    echo "Result: ❌ Failed - As expected for non-existent file"
else
    echo "Result: 🤔 Unexpected result:"
    echo "$result" | head -3
fi
echo ""

echo "Summary:"
echo "--------"
echo "If Test 2 succeeds while Test 1 fails, it suggests Claude doesn't maintain"
echo "a blocklist of child UUIDs - it's purely about the sessionId matching."
echo ""
echo "If Test 3 differs from Test 2, the parentUuid field matters."