# Agent Conversation Filtering

## Problem

Agent conversations (like `agent-e7363614`) were appearing in the dashboard's conversation list, but they can't be resumed. These are temporary subprocess conversations created by the main conversation to perform research or busy work.

## Solution

Filter out agent/sidechain conversations from the UI conversation list.

### How Agent Conversations are Identified

Agent conversations have distinctive markers:
1. **Filename pattern**: `agent-{uuid}.jsonl`
2. **Metadata field**: `"isSidechain": true`
3. **Metadata field**: `"agentId": "{uuid}"`

Example agent conversation metadata:
```json
{
    "isSidechain": true,
    "agentId": "98cf692c",
    "sessionId": "0c2f2910-691c-4409-ad52-b0b8b7dd08a7",
    "message": {
        "content": [
            {
                "text": "I'm ready to help you explore and search..."
            }
        ]
    }
}
```

### Changes Made

**File:** `/home/michael/InfiniQuest/tmp/claudeLoop/dashboard/conversation-tree-scanner.js`

#### 1. Detect sidechain conversations (lines 363-366)

Added detection during message parsing:

```javascript
// Find first user message and parent ID
for (let i = 0; i < lines.length; i++) {
    const msg = JSON.parse(lines[i]);

    // Detect agent/sidechain conversations (can't be resumed)
    if (msg.isSidechain === true || msg.agentId) {
        metadata.isSidechain = true;
    }

    // ... rest of message parsing
}
```

#### 2. Filter from tree structure (lines 926-933)

Modified `buildTreeStructure()` to exclude sidechain conversations:

```javascript
// Create map for quick lookup, excluding agent/sidechain conversations
for (const id in conversations) {
    const conv = conversations[id];
    // Skip agent conversations (temporary subprocesses that can't be resumed)
    if (conv.isSidechain) {
        continue;
    }
    convMap[id] = { ...conv };
}
```

### Results

- **Total conversations scanned**: 448
- **Agent conversations detected**: 402
- **Normal conversations shown**: 46
- **Agent conversations filtered**: All (not shown in UI)

### Test Results

```bash
# Run full scan
cd /home/michael/InfiniQuest/tmp/claudeLoop/dashboard
node conversation-tree-scanner.js full

# Check cache for sidechain conversations
cat ~/.claude/conversation-tree-cache.json | python3 -c "
import json, sys
data = json.load(sys.stdin)
sidechains = [c for c in data['conversations'].values() if c.get('isSidechain')]
print(f'Found {len(sidechains)} sidechain conversations')
"

# Output:
# Found 402 sidechain conversations
```

### Why Agent Conversations Can't Be Resumed

Agent conversations are:
- **Temporary subprocesses**: Created by the Task tool for specific research/work
- **No persistent session**: They exist only within the parent conversation's execution
- **Read-only context**: Generated for analysis, exploration, or computation
- **Auto-terminated**: Cleaned up when the parent conversation continues

Attempting to resume an agent conversation would fail because:
- The session ID is tied to the parent conversation
- The agent subprocess no longer exists
- The context was ephemeral

### Related Files

- `/home/michael/InfiniQuest/tmp/claudeLoop/dashboard/conversation-tree-scanner.js` - Scanner and filter logic
- `/home/michael/.claude/conversation-tree-cache.json` - Cached conversation metadata
- `/home/michael/.claude/projects/*/agent-*.jsonl` - Agent conversation files

## Date

Implemented: 2025-11-29
