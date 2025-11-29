# COMPLETE Dashboard Restoration Plan - With Continuous Comparison

## METHODOLOGY: For EVERY feature we implement:
1. **First**: Check the original `/tmp/claude-loop-unified-dashboard.js` for exact implementation
2. **Second**: Extract the working logic/styling
3. **Third**: Implement it properly in our modular structure
4. **Fourth**: Verify it works exactly the same (or better)

## Progress Tracking
- ✅ Completed
- 🔄 In Progress
- ⏳ Pending

## Implementation Phases

### Phase 1: Tabs for Tmux/Chat Switching ✅
**Compare with original first**: Search for tab implementation
- [x] Extract exact HTML structure for tabs
- [x] Find the switchTab() or similar function
- [x] Note the exact styling used
- [x] Implement: Add tabs properly in our modular version
- [x] Test tab switching preserves scroll position
- [ ] Add keyboard shortcuts (Shift+Tab)

### Phase 2: Chat Tab with Perfect Styling ✅
**Compare with original first**: Look for chat message rendering
- [x] Find exact CSS classes for left/right alignment
- [x] Extract the grey (#2a2a2e) background styling
- [x] Locate message type color coding
- [x] Implement left-aligned assistant messages
- [x] Implement right-aligned user messages
- [x] Add colored top bars for message types
- [x] Add 15% horizontal padding
- [x] Implement terminal-style code formatting
- [ ] Add proper timestamps
- [x] Implement auto-scroll to latest

### Phase 3: Complete Schedule Visualization ✅
**Compare with original first**: Find schedule timeline
- [x] Extract AM/PM timeline HTML structure
- [x] Find the schedule click handlers
- [x] Get the exact tooltip implementation
- [x] Implement full AM/PM timeline with hour blocks
- [x] Add interactive click-to-toggle
- [x] Add visual indicators for active/inactive
- [x] Implement schedule precision selector
- [x] Add quick presets (9-5, Night, All active, All inactive)
- [x] Display timezone
- [x] Add hour tooltips on hover
- [x] Save schedule state per session
- [x] Created modular dashboard-schedule.js file
- [x] Fixed drag functionality to match original (minute-level precision)
- [x] Fixed saveConfig API and resolved undefined errors
- [x] Made scheduleMinutes globally accessible
- [x] Added tooltip updates during drag

### Phase 4: All Conditional Messaging ⏳
**Compare with original first**: Search for conditional message config
- [ ] Find morning/afternoon/evening message handlers
- [ ] Extract low-context threshold logic
- [ ] Locate auto-compact trigger code
- [ ] Implement time-based messages
- [ ] Add context-based messages with thresholds
- [ ] Implement low context warning
- [ ] Add auto-compact trigger
- [ ] Implement after-compact message
- [ ] Add auto-finish detection
- [ ] Implement collapsible sections
- [ ] Add auto-save as you type

### Phase 5: Missing Utility Functions ✅
**Compare with original first**: Search for utility functions
- [x] Find ANSI converter implementation
- [x] Extract loadChatMessages function
- [x] Locate updateMiniTmux function
- [x] Add complete ANSI to HTML converter
- [x] Implement loadChatMessages() with JSONL parsing
- [x] Add updateMiniTmux() for tab content
- [x] Implement recursive text extraction
- [x] Add proper escaping for all text types

### Phase 6: Control Panel Features ⏳
**Compare with original first**: Review control panel structure
- [ ] Extract session management code
- [ ] Find loop control logic
- [ ] Get context monitor implementation
- [ ] Ensure session selector works (New/Kill/Rename)
- [ ] Verify loop control with status indicators
- [ ] Test quick config (name, delay, start with delay)
- [ ] Verify custom message textarea
- [ ] Test context monitor with color coding
- [ ] Verify real-time status updates
- [ ] Test virtual keyboard for tmux

### Phase 7: Console/Logging Features ⏳
**Compare with original first**: Find logging implementation
- [ ] Extract tmux console code
- [ ] Find log monitor controls
- [ ] Get auto-scroll logic
- [ ] Verify tmux console with auto-scroll
- [ ] Test system logs viewer
- [ ] Verify log monitor controls (Start/Stop)
- [ ] Test monitor type toggle (SH/JS)
- [ ] Verify message monitor status
- [ ] Test clear and refresh buttons

### Phase 8: Responsive Design & Polish ⏳
- [ ] Maintain 450px/1fr grid on desktop
- [ ] Add media queries for tablets
- [ ] Add media queries for phones
- [ ] Implement smooth animations
- [ ] Add loading states for async operations
- [ ] Add error states with recovery
- [ ] Preserve dark mode preference
- [ ] Test on multiple screen sizes

### Phase 9: Final Verification ⏳
**Compare side-by-side**: Open both versions
- [ ] Test every single feature
- [ ] Ensure modular version matches or exceeds original
- [ ] Fix any discrepancies
- [ ] Add improvements while maintaining compatibility
- [ ] Document any improvements made

## Key Comparison Points in Original
- Line 1426-2700: Main HTML structure
- Line 2594-6000: JavaScript functions
- Line 1433-1900: CSS styling
- Line 6000+: Event handlers and utilities

## Files Being Modified
1. `/home/michael/InfiniQuest/tmp/claudeLoop/dashboard/dashboard.html` - Structure
2. `/home/michael/InfiniQuest/tmp/claudeLoop/dashboard/dashboard-styles.css` - Styling
3. `/home/michael/InfiniQuest/tmp/claudeLoop/dashboard/dashboard-utils.js` - Utilities
4. `/home/michael/InfiniQuest/tmp/claudeLoop/dashboard/dashboard-api.js` - API calls
5. `/home/michael/InfiniQuest/tmp/claudeLoop/dashboard/claude-loop-unified-dashboard.js` - Server

## Testing Commands
```bash
# Restart dashboard after changes
./restart-dashboard.sh

# View logs
tail -f /tmp/claude-dashboard.log

# Test in browser
http://192.168.1.2:3335/

# Compare with original
diff -u /tmp/claude-loop-unified-dashboard.js claude-loop-unified-dashboard.js
```

## Notes
- The original is functional but monolithic (7,018 lines)
- Our modular version is currently at 1,700 lines (main file)
- Goal: Match ALL functionality while maintaining clean separation
- No shortcuts - implement everything properly