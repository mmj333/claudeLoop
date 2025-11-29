# CLAUDE.md - ClaudeLoop Dashboard Rules

## Performance Optimization Rules

### NO HASHING FOR CHANGE DETECTION
**NEVER** suggest using hashing for change detection or caching.
- Hashing is computationally expensive, and we're trying to SAVE CPU usage, not increase it
- Use simple timestamp-based debouncing instead
- Different operations get different debounce times

### Debounce Times
- Compact detection: 60 seconds (rarely changes quickly)
- Prompt detection: 5 seconds (needs responsiveness)
- Activity detection: 2 seconds (changes frequently)
- Context check: 10 seconds (changes slowly)

### General Principles
- Simple solutions over complex ones
- Timestamp debouncing over content hashing
- CPU efficiency is a priority
- Don't over-engineer solutions

## Dashboard Specific Rules

### Message Sending
- Manual messages should NOT retry Enter key
- Auto-loop messages can retry Enter key if configured
- Compact commands should NOT retry Enter key

### Logging
- Use the tiered logging system (error, warn, info, debug, verbose)
- Default to 'info' level
- Keep logs concise and meaningful

## Testing
- Always restart dashboard after making changes: `./restart-dashboard.sh` (symlink to `dashboard/restart-dashboard.sh`)
- Monitor logs: `tail -f /tmp/claude-dashboard.log`
- Test both manual and auto-loop behaviors separately

## Dashboard Location
- Dashboard v1 runs at: http://192.168.1.2:3335
- Main files in: `/home/michael/InfiniQuest/tmp/claudeLoop/dashboard/`
  - `dashboard.html` - Main dashboard UI
  - `dashboard-styles.css` - Styles (includes collapsible sidebar)
  - `claude-loop-unified-dashboard.js` - Backend server
  - `restart-dashboard.sh` - Restart script (also symlinked to parent folder)