# Claude Loop Dashboard Modularization Plan

## Current State
- **7,667 lines in single file**: claude-loop-unified-dashboard.js
- Multiple template literal escaping issues
- Hard to debug (error at line 1537 in browser doesn't match source)
- Violates CLAUDE.md best practices

## Phase 1: Quick Wins (Do First - Before Compact)

### 1. Extract CSS → dashboard-styles.css
- Lines 1530-2270 (740 lines of CSS)
- Serve as static file
- Add route: `/dashboard-styles.css`
- Link with: `<link rel="stylesheet" href="/dashboard-styles.css">`

### 2. Expand dashboard-utils.js
Move these functions from main file:
- `escapeHtml()` 
- `formatCodeBlocks()`
- `loadChatMessages()`
- `updateMiniTmux()`
- `convertAnsiToHtml()`
- All tmux control functions

### 3. Create dashboard-api.js
Centralize all API calls:
- Move all fetch() calls
- Create consistent error handling
- Export as module

## Phase 2: Core Restructuring (After Compact)

### 4. Extract HTML Template → dashboard.html
- Static HTML structure (lines 2271-2969)
- Load CSS/JS normally (no template literals!)
- Use data attributes for dynamic content

### 5. Create Feature Modules
- `dashboard-chat.js` - Chat tab functionality
- `dashboard-console.js` - Console tab functionality  
- `dashboard-status.js` - Status monitoring
- `dashboard-config.js` - Configuration management
- `dashboard-schedule.js` - Schedule functionality

### 6. Simplify Main Server
- Rename to `dashboard-server.js`
- Just serve files and route APIs
- Import handlers from modules

## Phase 3: Best Practices

### 7. API Routes Module → api-routes.js
- Extract handleAPI function (lines 138-888)
- Use Express-like routing
- Add proper middleware

### 8. Session Management → session-manager.js
- Tmux session handling
- Loop management  
- Context tracking

## Benefits
- **10x easier debugging** - Errors map to correct files/lines
- **Browser caching** - Static files cached
- **Parallel editing** - No more conflicts
- **Testable** - Individual modules can be tested
- **Maintainable** - Single responsibility per file

## Progress Tracking
- [x] CSS extracted (DONE - saved 740 lines!)
- [x] dashboard-utils.js expanded (DONE - added ANSI converter, chat loader, tmux viewer)
- [x] dashboard-api.js created (DONE - centralized all API calls)
- [x] HTML template extracted (DONE - removed 5,857 lines!)
- [x] dashboard-main.js created (DONE - all client-side JavaScript)
- [ ] Server simplified (partially done - old template removed)
- [ ] API routes modularized
- [ ] Session management extracted

## Extracted Modules (Phase 1 & 2 Progress)
- **dashboard-styles.css**: 740 lines of CSS
- **dashboard-utils.js**: 335 lines
  - formatInlineCode()
  - formatCodeBlocks()
  - formatMessageContent()
  - escapeHtml()
  - formatTimestamp()
  - truncateText()
  - convertAnsiToHtml() - Full ANSI to HTML converter
  - processAnsiCode() - ANSI code processor
  - loadChatMessages() - Chat message loader with formatting
  - updateMiniTmux() - Tmux viewer updater

- **dashboard-api.js**: 210 lines
  - Centralized API request handler
  - All tmux session management APIs
  - Configuration APIs
  - Control & messaging APIs
  - Status & context APIs
  - Log monitoring APIs
  - Conversation management APIs
  - File browser APIs

- **dashboard.html**: 400 lines
  - Complete HTML structure
  - All tabs and UI elements
  - Script references to modular JS files

- **dashboard-main.js**: 770 lines
  - All client-side JavaScript
  - Tab switching logic
  - Event handlers
  - UI updates
  - Integration with dashboardAPI and dashboardUtils

**Main file reduction**: From 7,667 lines to 1,700 lines (77% reduction!)
**Lines extracted**: ~6,000 lines across 5 files

## Notes
- Start with CSS extraction (5 min, huge impact)
- Each step makes the next one easier
- Can be done incrementally
- Total effort: ~2 hours for complete modularization