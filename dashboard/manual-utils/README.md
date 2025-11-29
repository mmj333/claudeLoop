# Manual Utilities

These scripts provide manual control over various Claude Loop components. They are not automatically called by the dashboard but can be useful for debugging, testing, or special operations.

## Message Monitor Control
- `start-message-monitor.sh` - Manually start the message monitor service (checks for context %, compact triggers, etc.)
- `stop-message-monitor.sh` - Stop the message monitor service
- `test-message-monitor.sh` - Test the message monitor with sample log entries

## Session Management
- `cleanup-loops.sh` - Clean up stale tmux sessions and processes
- `claude-loop-auto-resume.sh` - Set up automatic session resume after a specified time

## Usage Examples

### Start the message monitor:
```bash
./manual-utils/start-message-monitor.sh
```

### Clean up old sessions:
```bash
./manual-utils/cleanup-loops.sh
```

### Set auto-resume for 30 minutes:
```bash
./manual-utils/claude-loop-auto-resume.sh 30
```

Note: The message monitor is a shared service that monitors ALL Claude sessions. It provides a status API at http://localhost:3458/status