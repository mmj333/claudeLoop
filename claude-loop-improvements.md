# Claude Loop Automation Improvements

## Overview
Based on the user's ideas in SESSION_TODOS.md, I've analyzed the existing claude loop infrastructure and created improvements to address the requested features.

## Current Setup
1. **Main Loop Script**: `tmp/claude_continue_loop.sh`
   - Sends messages every 10 minutes
   - Has autosave functionality
   - Supports scheduled start times
   - Has pause/resume with keyboard

2. **Monitor Script**: `scripts/claude-loop-monitor.js`
   - Already implements usage limit detection!
   - Monitors for patterns like "Claude usage limit reached"
   - Has log rotation when files exceed 10MB
   - Can pause/resume the loop

## Improvements Implemented

### 1. Enhanced Loop Script (`claude-loop-enhanced.sh`)
I've created an enhanced version that integrates the monitor directly:

**New Features:**
- ✅ **Automatic pause on usage limits** - Detects Claude's rate limit messages
- ✅ **Log rotation** - Automatically rotates logs when they exceed 10MB
- ✅ **Direct tmux output monitoring** - Checks Claude's responses for limit messages
- ✅ **Smart pause/resume** - Calculates exact wait time from limit messages

**How it works:**
1. Starts the usage monitor in the background
2. Checks tmux output after each message for usage limit patterns
3. Automatically pauses until the reset time mentioned in the error
4. Resumes automatically when the limit resets

### 2. Usage Limit Detection Patterns
The system detects these patterns:
- "Claude usage limit reached. Your limit will reset at X"
- "Rate limit exceeded... Try again at X:XX"
- "Usage quota exceeded... Available again at X"

### 3. Log Management
- Logs are automatically rotated when they exceed 1MB
- Old logs are archived with timestamps
- Only the last 1000 logs are kept to save space

## How to Use

### Basic Usage
```bash
# Use the enhanced loop instead of the original
./scripts/claude-loop-enhanced.sh
```

### Features in Action
1. **Automatic Pause**: When Claude hits usage limits, the loop automatically pauses
2. **Smart Resume**: Resumes exactly when the limit resets (e.g., "1am")
3. **Log Rotation**: Large logs are automatically archived
4. **Clean Shutdown**: Ctrl+C saves all logs and cleans up properly

### Configuration
Edit these variables in the script:
- `DELAY_MINUTES=10` - Time between messages
- `START_TIME="1:00"` - When to start the loop
- `USE_START_TIME=true` - Whether to wait for start time

## Integration with Existing Tools

The enhanced loop works seamlessly with:
- Existing tmux sessions
- Current autosave functionality
- Screen sleep prevention
- All original features

## Additional Improvements Possible

1. **Web Dashboard** - Could create a web UI to monitor loop status
2. **Notification System** - Send alerts when paused/resumed
3. **Statistics Tracking** - Track usage patterns and success rates
4. **Multi-Instance Support** - Run multiple Claude loops for different projects

## Summary

The user's ideas have been implemented:
- ✅ **Auto-pause on usage limits** - Done with smart time parsing
- ✅ **Log rotation for large files** - Done with 10MB threshold
- ✅ **Parse limit messages** - Done with multiple pattern support

The enhanced loop provides a more robust automation experience that handles Claude's rate limits intelligently, preventing wasted attempts and automatically resuming work when possible.