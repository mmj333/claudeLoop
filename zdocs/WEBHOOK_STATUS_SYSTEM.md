# Webhook Status System

## Overview

The webhook status system allows Claude Code sessions to POST status updates to the dashboard, enabling automated responses and review workflows. This replaces the previous phrase-scraping approach with a more reliable webhook-based system.

## User Request

> "Instead of scraping some messages for situations... we could have an endpoint on our claude-loop dashboard ready to receive a post or put or whatever (a webhook basically) indicating that claude is done for now, and which loop it's for."

> "Perhaps the decision path can be directed by some logic, [checkbox] thoroughly review work x # times before continuing on to the next task."

## Implementation

### Webhook Endpoint

**Endpoint**: `POST /api/webhook/status`

**Request Body**:
```json
{
  "session": "claude-loop16",
  "status": "done|idle|waiting|stuck|needs-input|auto-compact",
  "context": {
    "task": "Optional task description",
    "question": "Optional question for stuck/needs-input status"
  }
}
```

**Response**:
```json
{
  "received": true,
  "action": "review|next-task|acknowledged|needs-attention|compact",
  "message": "Optional message that will be sent",
  "reviewsRemaining": 2
}
```

### Status Types

1. **done** - Work completed, triggers review loop
   - If reviews required: sends review message
   - If reviews complete: sends next-task message
   - Increments review counter automatically

2. **idle** - Session is idle
   - Action: `acknowledged`
   - No automated response (handled by on-idle message system)

3. **waiting** - Waiting for something
   - Action: `acknowledged`
   - No automated response

4. **stuck** - Session is stuck
   - Action: `needs-attention`
   - Logs warning with context

5. **needs-input** - Requires user input
   - Action: `needs-attention`
   - Logs warning with context/question

6. **auto-compact** - Request context compaction
   - Action: `compact`
   - Triggers `/compact` command with 5-minute debounce
   - Replaces phrase scraping for "let's compact" detection
   - More reliable than regex pattern matching

### Review Loop System

The review loop system enables Claude to thoroughly review completed work before moving to the next task.

**Configuration (per session)**:
- `enabled`: Enable/disable review loop (default: false)
- `reviewsBeforeNextTask`: Number of reviews required (default: 1, range: 0-10)
- `reviewMessage`: Message sent for each review request
- `nextTaskMessage`: Message sent when reviews are complete

**How It Works**:

1. Claude POSTs `status: "done"` when work is complete
2. Dashboard increments review counter for that session
3. If counter < reviewsBeforeNextTask:
   - Sends `reviewMessage` to tmux session
   - Returns `action: "review"` with `reviewsRemaining` count
4. If counter >= reviewsBeforeNextTask:
   - Sends `nextTaskMessage` to tmux session
   - Resets counter to 0
   - Returns `action: "next-task"`

**Task Change Detection**:
- Creates hash of `context.task` field
- Resets review counter when task hash changes
- Prevents review counter from persisting across different tasks

### UI Configuration

Located in dashboard's "Conditional Messages" section under "Review Settings":

- ✓ Checkbox to enable/disable review loop
- ✓ Collapsible section with arrow indicator
- ✓ Number input for reviews count (0-10)
- ✓ Review message textarea with auto-resize
- ✓ Next task message textarea with auto-resize
- ✓ Help text explaining webhook usage
- ✓ Auto-save on change

### Files Modified

#### `dashboard/claude-loop-unified-dashboard.js`

**Added webhook state tracking** (line 3738):
```javascript
const webhookState = {}; // session -> { reviewCount, lastStatus, lastTaskHash, lastStatusTime }
```

**Added review settings to config** (lines 212-217):
```javascript
reviewSettings: {
  enabled: false,
  reviewsBeforeNextTask: 1,
  reviewMessage: "Please review the work you just completed. Are there any improvements needed?",
  nextTaskMessage: "Work completed and reviewed. Please proceed to the next task."
}
```

**Added /api/webhook/status endpoint** (lines 2531-2666):
- Validates status and session
- Loads session config for review settings
- Tracks review count per session
- Detects task changes via hash
- Sends appropriate messages based on review count
- Logs all status updates

#### `dashboard/dashboard-conditional.js`

**Added UI section** (lines 239-269):
- Enable/disable checkbox with collapse/expand
- Review count input
- Review message textarea
- Next task message textarea
- Usage instructions

**Added to defaultConfig** (lines 57-62):
```javascript
reviewSettings: {
  enabled: false,
  reviewsBeforeNextTask: 1,
  reviewMessage: "...",
  nextTaskMessage: "..."
}
```

**Added config loading** (lines 426-438):
- Loads checkbox state
- Loads review count
- Loads review messages
- Handles collapse/expand state

**Added config saving** (lines 552-557):
- Saves enabled state
- Saves review count
- Saves both messages
- Triggers auto-save

## Usage Example

### 1. Enable Review Loop

1. Open dashboard at `http://192.168.1.2:3335`
2. Navigate to "Conditional Messages"
3. Scroll to "Review Settings"
4. Check "Enable Review Loop"
5. Set number of reviews (e.g., 2)
6. Customize review message
7. Customize next task message
8. Settings auto-save

### 2. Claude Integration

Claude would include code like this in its workflow:

```javascript
// When work is completed
fetch('http://192.168.1.2:3335/api/webhook/status', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    session: 'claude-loop16',
    status: 'done',
    context: {
      task: 'Implemented webhook status system'
    }
  })
});
```

### 3. Workflow

**First completion** (review count: 0 → 1):
- Claude: POSTs `status: "done"`
- Dashboard: Sends review message to tmux
- Claude: Reviews work, finds improvement
- Claude: Makes improvement

**Second completion** (review count: 1 → 2):
- Claude: POSTs `status: "done"`
- Dashboard: Reviews complete! Sends next-task message
- Dashboard: Resets counter to 0
- Claude: Proceeds to next task

## Benefits Over Phrase Scraping

1. **Reliability**: No false positives from similar phrases in output
2. **Structured Data**: Context fields provide additional information
3. **Immediate Response**: No polling delay, instant acknowledgment
4. **Flexible**: Easy to add new status types or context fields
5. **Debugging**: Clear logs show exactly what status was sent when

## Logging

All webhook activity is logged with appropriate levels:

```
[Dashboard:INFO] [Webhook] Status update from claude-loop16: done
[Dashboard:INFO] [Webhook] Review count for claude-loop16: 1/2
[Dashboard:INFO] [Webhook] Scheduling review message for claude-loop16 (1 reviews remaining)
[Dashboard:INFO] [Webhook] Sent review message to claude-loop16
```

For stuck/needs-input:
```
[Dashboard:WARN] [Webhook] Session claude-loop16 needs attention: stuck
[Dashboard:WARN] [Webhook] Question: Not sure how to proceed
```

## Testing

Successfully tested all status types:

```bash
# Test done status
curl -X POST http://192.168.1.2:3335/api/webhook/status \
  -H "Content-Type: application/json" \
  -d '{"session": "claude-loop16", "status": "done", "context": {"task": "Test"}}'
# Response: {"received":true,"action":"next-task"}

# Test idle status
curl -X POST http://192.168.1.2:3335/api/webhook/status \
  -H "Content-Type: application/json" \
  -d '{"session": "claude-loop16", "status": "idle"}'
# Response: {"received":true,"action":"acknowledged"}

# Test stuck status
curl -X POST http://192.168.1.2:3335/api/webhook/status \
  -H "Content-Type: application/json" \
  -d '{"session": "claude-loop16", "status": "stuck", "context": {"question": "Help!"}}'
# Response: {"received":true,"action":"needs-attention"}

# Test invalid status
curl -X POST http://192.168.1.2:3335/api/webhook/status \
  -H "Content-Type: application/json" \
  -d '{"session": "claude-loop16", "status": "invalid"}'
# Response: {"error":"Invalid status. Must be one of: done, idle, waiting, stuck, needs-input, auto-compact"}

# Test auto-compact status
curl -X POST http://192.168.1.2:3335/api/webhook/status \
  -H "Content-Type: application/json" \
  -d '{"session": "claude-loop16", "status": "auto-compact"}'
# Response: {"received":true,"action":"compact"}
```

## What Was Replaced

The webhook system replaced CPU-intensive phrase scraping:

### Before (Phrase Scraping)
- **detectCompactPhrase()** function: ~50 lines of regex pattern matching
- Scanned tmux output for "let's compact" or "/compact" phrases
- Cached results for 60 seconds to reduce CPU load
- Added "let's compact!" instruction to low-context messages
- Prone to false positives from similar phrases in output

### After (Webhook)
- **auto-compact** status: Single webhook POST request
- No regex scanning, no false positives
- Same debounce protection (5-minute cooldown)
- Explicit status reporting from Claude
- ~100 lines of code removed

### Performance Impact
- **CPU Usage**: Reduced (no regex scanning every 60 seconds)
- **Reliability**: Improved (explicit status vs phrase matching)
- **Code Complexity**: Reduced (~100 lines removed)
- **Idle Detection**: Still uses scraping (checks for "Esc to interrupt" - no webhook alternative)

## Future Enhancements

Potential improvements:
1. **Escalation System**: Auto-escalate from Haiku → Opus after N stuck statuses
2. **Status History**: Track and display status timeline in UI
3. **Email Notifications**: Send alerts for stuck/needs-input statuses
4. **Metrics Dashboard**: Visualize review counts, task completion times
5. **Webhook Logs View**: UI panel showing recent webhook activity

## Date

Implemented: 2025-11-29
