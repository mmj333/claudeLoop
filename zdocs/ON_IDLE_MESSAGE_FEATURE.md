# On Idle Message Feature

## Overview

Added a new "On Idle Message" conditional message that automatically sends a message when Claude's session becomes idle (no longer processing/busy).

## User Request

> "Could we add a feature to my controls on the left, perhaps the 'conditional messages' section would make the most sense, where I can enable a message that would send when the session becomes idle?"

## Implementation

### Priority System

The conditional messages now have this priority order (highest to lowest):

1. **On Idle Message** - Triggers when Claude is idle beyond threshold
2. **After Compact Message** - Triggers after /compact based on line count
3. **Low Context Message** - Triggers when context usage is below threshold
4. **Time-Based Messages** - Morning/Afternoon/Evening based on hour
5. **Standard Message** - Default fallback message

### Configuration

**Default Settings:**
```javascript
onIdleMessage: {
  enabled: false,
  idleThresholdSeconds: 30,
  message: "What's the status? Please provide a brief update on what you're working on."
}
```

### UI Location

Added to the Conditional Messages section in the left sidebar, positioned after "After Compact Message".

**UI Elements:**
- ✓ Checkbox to enable/disable
- ✓ Collapsible section with arrow indicator
- ✓ Idle threshold input (10-300 seconds)
- ✓ Message textarea with auto-resize
- ✓ Help text: "Sends when Claude becomes idle (no 'Esc to interrupt' prompt)"
- ✓ Auto-save on change

### How It Works

1. **Idle Detection:**
   - Backend tracks when Claude last showed busy indicator ("Esc to interrupt")
   - If no busy indicator detected, calculates idle time since last activity
   - Compares idle time against configured threshold

2. **Message Triggering:**
   - When loop sends a message, it checks `getActiveConditionalMessage()`
   - If idle message is enabled AND session is idle beyond threshold
   - Returns idle message with highest priority

3. **Activity Tracking:**
   - `state.lastActivityTime` - Last time Claude showed busy indicator
   - `state.isBusy` - Current busy state (has interrupt prompt)
   - Idle time calculated as: `(Date.now() - state.lastActivityTime) / 1000`

### Files Modified

#### `dashboard-conditional.js`

1. **Added default config** (lines 52-56):
```javascript
onIdleMessage: {
  enabled: false,
  idleThresholdSeconds: 30,
  message: "What's the status? Please provide a brief update on what you're working on."
}
```

2. **Added UI** (lines 220-237):
```javascript
<!-- On Idle Message -->
<div class="control-group">
  <input type="checkbox" id="idle-enabled">
  <span id="idle-arrow">▶</span>
  On Idle Message

  <div id="idle-settings" style="display: none;">
    <label>Idle threshold (seconds)</label>
    <input type="number" id="idle-threshold" min="10" max="300">
    <textarea id="idle-message"></textarea>
    <div>Sends when Claude becomes idle (no "Esc to interrupt" prompt)</div>
  </div>
</div>
```

3. **Added config loading** (lines 376-386):
```javascript
const idleEnabled = document.getElementById('idle-enabled');
if (idleEnabled) {
  idleEnabled.checked = this.config.onIdleMessage?.enabled || false;
  // ... load threshold and message
}
```

4. **Added config saving** (lines 494-498):
```javascript
this.config.onIdleMessage = this.config.onIdleMessage || {};
this.config.onIdleMessage.enabled = document.getElementById('idle-enabled')?.checked;
this.config.onIdleMessage.idleThresholdSeconds = parseInt(document.getElementById('idle-threshold')?.value);
this.config.onIdleMessage.message = document.getElementById('idle-message')?.value;
```

#### `claude-loop-unified-dashboard.js`

1. **Added idle detection** (lines 4163-4183):
```javascript
// Check if session is idle
let isIdle = false;
let idleTime = 0;
if (state.lastActivityTime) {
  idleTime = (Date.now() - state.lastActivityTime) / 1000; // seconds
  isIdle = !state.isBusy && idleTime > 0;
}

// Priority 1: On Idle message (highest priority when idle)
if (messages.onIdleMessage?.enabled && isIdle) {
  const threshold = messages.onIdleMessage.idleThresholdSeconds || 30;
  if (idleTime >= threshold) {
    log.info(`[Conditional] Using on-idle message (idle for ${idleTime.toFixed(1)}s)`);
    return {
      type: 'onIdle',
      message: messages.onIdleMessage.message,
      priority: 1,
      idleTime: idleTime
    };
  }
}
```

2. **Updated priority numbers** (lines 4185-4260):
- After Compact: priority 2 (was 1)
- Low Context: priority 3 (was 2)
- Time-Based: priority 4 (was 3)
- Standard: priority 5 (was 4)

## Usage Example

1. Open dashboard at `http://192.168.1.2:3335`
2. Expand "Conditional Messages" in left sidebar
3. Check "On Idle Message" checkbox
4. Set idle threshold (e.g., 30 seconds)
5. Customize message (e.g., "What's the status?")
6. Settings auto-save

When Claude finishes processing and becomes idle for 30+ seconds, the loop will automatically send your configured message.

## Use Cases

- **Status checks**: Ask Claude what it's working on when it goes idle
- **Continuation prompts**: "Please continue" when work seems stalled
- **Progress updates**: "What progress have you made?" after idle period
- **Debugging**: "Are you stuck? Need help?" when unexpectedly idle

## Testing

1. Enable the feature with 30 second threshold
2. Start a Claude loop session
3. Wait for Claude to finish a task and become idle
4. After 30 seconds, the configured message should be sent automatically

## Logs

Activity tracking appears in dashboard logs:
```
[Activity] Session claude: Claude is busy (interrupt prompt detected)
[Activity] Session claude: Claude is idle (45.2s since last busy)
[Conditional] Using on-idle message (idle for 45.2s)
```

## Date

Implemented: 2025-11-29
