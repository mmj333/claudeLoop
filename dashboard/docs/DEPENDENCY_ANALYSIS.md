# Dashboard Dependency Analysis

## Files ACTIVELY USED by claude-loop-unified-dashboard.js:

### Core Files (KEEP):
1. **claude-loop-unified-dashboard.js** - Main dashboard file
2. **loop-config.json** - Configuration storage (referenced in code)
3. **log-monitor-manager.sh** - Manages log monitor instances (API calls)
4. **log-monitor.sh** - Actual log monitoring script (called by manager)
5. **tmux-claude-setup.sh** - Sets up tmux sessions (API endpoint)
6. **restart.sh** - Restarts the dashboard
7. **stop.sh** - Stops the dashboard
8. **claude-loop-auto-resume.sh** - Auto-resume functionality (referenced in code)

### Parent Directory Dependencies:
- **../claude-loop-enhanced-v2.sh** - Main loop script (started by dashboard)

## Files that can be ARCHIVED:

### Old Dashboard Versions:
- claude-loop-monitor-fixed.js (replaced by unified dashboard)
- claude-loop-monitor-improved.js (replaced by unified dashboard)
- start-claude-dashboard.sh (old starter script)
- start-dashboard.sh (old starter script)
- start-enhanced-dashboard.sh (old starter script)

### Test/Analysis Scripts:
- analyze-ansi-patterns.js (testing tool)
- test-ansi-comparison.js (testing tool)
- test-ansi-detailed.js (testing tool)
- test-ansi-vs-html.js (testing tool)
- test-persistence.js (testing tool)
- test-settings.sh (testing tool)

### Utility Scripts (KEEP for emergencies):
- cleanup-loops.sh - Nuclear cleanup option when processes go rogue
  * Kills ALL claude loop processes
  * Cleans up stale lock/pid files
  * Still useful even though log-monitor-manager prevents duplicates
  * Good for emergency resets

## Summary:
The unified dashboard has consolidated functionality from multiple older scripts.
Most test scripts and old dashboard versions can be safely archived.