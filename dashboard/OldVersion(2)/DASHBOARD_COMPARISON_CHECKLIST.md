# Dashboard Comparison Checklist
## Goal: Make modular version feel exactly like the original

### Current Status
- ✅ Successfully modularized from 7,018 lines to 1,700 lines (main file)
- ✅ Extracted: CSS (740 lines), Utils (344 lines), API (223 lines), HTML (583 lines)
- ⚠️ UI doesn't match original feel/layout yet

### Files Reference
- **Original (backup)**: `/tmp/claude-loop-unified-dashboard.js` (7,018 lines)
- **Modular version**: `/home/michael/InfiniQuest/tmp/claudeLoop/dashboard/`
  - `claude-loop-unified-dashboard.js` (server)
  - `dashboard.html` (structure)
  - `dashboard-styles.css` (styling)
  - `dashboard-utils.js` (utilities)
  - `dashboard-api.js` (API calls)

### Comparison Checklist

#### Visual/Layout
- [ ] **Grid Layout**: Should be 2-column (450px left, 1fr right)
- [ ] **Left Column Cards**:
  - [ ] Session selector with New/Kill/Rename buttons
  - [ ] Loop Control with status indicator
  - [ ] Quick Config (name, delay, start with delay)
  - [ ] Custom Message textarea
  - [ ] Schedule (collapsible)
  - [ ] Context monitor with percentage bar
- [ ] **Right Column Cards**:
  - [ ] Tmux Console (with auto-scroll)
  - [ ] Recent Messages/Conversation
  - [ ] System Logs
- [ ] **Header**: Title + Dark mode + Stop All buttons
- [ ] **Dark mode**: Should persist in localStorage

#### Functionality
- [ ] **Session Management**:
  - [ ] Load tmux sessions on startup
  - [ ] Create new session
  - [ ] Kill session
  - [ ] Switch between sessions
- [ ] **Loop Control**:
  - [ ] Start/Stop/Pause/Resume buttons work
  - [ ] Status indicator updates (green/red)
  - [ ] Config saves per session
- [ ] **Real-time Updates**:
  - [ ] Tmux console refreshes every 2 seconds
  - [ ] Context percentage updates every 10 seconds
  - [ ] Status updates every 5 seconds
  - [ ] Conversation loads every 5 seconds
- [ ] **Custom Messages**:
  - [ ] Send to tmux properly
  - [ ] Clear after sending
- [ ] **Schedule**:
  - [ ] Collapsible section
  - [ ] Schedule modal for editing

#### Styling Details
- [ ] **Colors**: Dark theme (--bg-primary: #0a0a0a)
- [ ] **Cards**: Proper borders and spacing
- [ ] **Buttons**: Correct button styles (primary, danger, warning, etc.)
- [ ] **Tmux output**: ANSI colors converted properly
- [ ] **Context bar**: Color changes based on percentage (green/orange/red)
- [ ] **Fonts**: System font stack

#### JavaScript Behavior
- [ ] All functions from original are present
- [ ] Event handlers properly attached
- [ ] API calls use dashboardAPI module
- [ ] Utils use dashboardUtils module
- [ ] No console errors on load
- [ ] No 404s for resources

### Next Steps After Compact
1. Load original in one tab, modular in another
2. Go through checklist item by item
3. Copy missing HTML structure from original
4. Ensure all JavaScript functions are ported
5. Test all interactive features
6. Fine-tune CSS to match exactly

### Key Differences Found So Far
1. Original had more detailed HTML structure in grid
2. Original had all JavaScript inline (now needs proper separation)
3. Some utility functions might be missing
4. CSS might need more specific selectors

### Testing Commands
```bash
# View original
curl -s http://192.168.1.2:3335/ | head -100

# Check for 404s
curl -I http://192.168.1.2:3335/dashboard-styles.css
curl -I http://192.168.1.2:3335/dashboard-utils.js
curl -I http://192.168.1.2:3335/dashboard-api.js

# Compare file structures
diff -u <(sed -n '1427,1927p' /tmp/claude-loop-unified-dashboard.js) dashboard.html | head -50
```