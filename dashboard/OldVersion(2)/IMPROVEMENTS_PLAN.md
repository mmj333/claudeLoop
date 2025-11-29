# Claude Loop Dashboard - Improvements Plan

## Completed Improvements ✅

### 1. Configuration Management Refactoring (Completed 2025-08-19)
- Created `config-utils.js` module with centralized config management
- Implemented `getSessionConfig()` helper for consistent config reading
- Removed duplicate `conversationId` storage (now only in `session-map.json`)
- Updated all direct file access to use the helper functions
- Benefits: DRY principle, single source of truth, better maintainability

## Pending Improvements 🎯

### High Priority

#### 0. API Routes Modularization (URGENT)
**Current Issues:**
- ALL API endpoints are in one massive switch statement in `claude-loop-unified-dashboard.js`
- Server file is 2000+ lines and growing
- Mixing HTTP server logic with business logic
- Hard to find specific endpoints
- Difficult to test individual routes

**Proposed Solution:**
- Create `routes/` directory with separate files for each API group:
  - `routes/tmux.js` - Tmux-related endpoints
  - `routes/config.js` - Configuration endpoints
  - `routes/conversation.js` - Conversation management
  - `routes/loop.js` - Loop control endpoints
  - `routes/session.js` - Session management
- Use Express.js or similar routing library
- Keep main file focused on server setup only

**Benefits:**
- Much easier to maintain and find code
- Can test routes independently
- Follows standard Node.js patterns
- Reduces merge conflicts in team development
- Clearer separation of concerns

### High Priority

#### 1. Active Loops Management Module
**Current Issues:**
- `loadActiveLoops()` and `saveActiveLoops()` functions scattered in main file
- Direct file access to `active-loops.json` throughout code
- Inconsistent error handling for active loops

**Proposed Solution:**
- Create `active-loops-manager.js` module
- Centralize all active loop operations
- Implement proper locking for concurrent access
- Add validation for loop state transitions

**Benefits:**
- Cleaner code organization
- Consistent state management
- Easier to test and debug
- Prevent race conditions

#### 2. Pause State Management Module
**Current Issues:**
- Multiple direct file operations to `/tmp/claude_loop_paused`
- Scattered pause/resume logic
- Resume time handling mixed with pause state

**Proposed Solution:**
- Create `pause-state-manager.js` module
- Centralize pause/resume operations
- Implement proper state machine for pause states
- Add pause history tracking

**Benefits:**
- Single source of truth for pause states
- Better pause/resume reliability
- Ability to track pause patterns

### Medium Priority

#### 3. Context State Management Module
**Current Issues:**
- In-memory only `contextState` object
- No persistence across restarts
- Per-session state tracking scattered

**Proposed Solution:**
- Create `context-state-manager.js` module
- Add optional persistence to disk
- Implement state recovery after crashes
- Add context history tracking

**Benefits:**
- Better context tracking
- Survive dashboard restarts
- Historical context analysis

#### 4. Log File Operations Module
**Current Issues:**
- Repeated patterns for reading logs
- Similar error handling duplicated
- No centralized log rotation logic

**Proposed Solution:**
- Create `log-reader.js` module
- Implement streaming log reader
- Add log rotation support
- Centralize error handling

**Benefits:**
- Efficient log reading
- Consistent error handling
- Better performance for large logs

### Low Priority

#### 5. Conversation File Operations Consolidation
**Current Issues:**
- Partially modularized (ConversationReader, ConversationTreeScanner exist)
- Still some direct file reading for conversations
- Inconsistent conversation handling

**Proposed Solution:**
- Create unified `conversation-manager.js` module
- Consolidate all conversation operations
- Add conversation caching layer
- Implement conversation search

**Benefits:**
- Single API for all conversation operations
- Better performance with caching
- Easier to add new features

#### 6. File Path Management Module
**Current Issues:**
- Hardcoded paths scattered throughout code
- `/tmp/` files paths repeated
- `.claude/projects/` paths duplicated

**Proposed Solution:**
- Create `paths.js` module with all path constants
- Implement path validation
- Add path helpers for common operations
- Support for configurable paths

**Benefits:**
- Easy to change paths in one place
- Prevent path-related bugs
- Support for different environments

## Implementation Guidelines

1. **Module Structure:**
   - Each module should export clear, focused functions
   - Include JSDoc comments for all public functions
   - Implement error handling within modules
   - Add logging for debugging

2. **Testing:**
   - Create test files for each new module
   - Test error conditions
   - Verify backward compatibility

3. **Migration:**
   - Update one module at a time
   - Keep old code working during transition
   - Test thoroughly before removing old code

4. **Documentation:**
   - Update this plan as improvements are completed
   - Document any API changes
   - Add usage examples for new modules

## Notes

- Focus on high-impact, low-risk improvements first
- Maintain backward compatibility where possible
- Consider performance implications for all changes
- Keep modules focused and single-purpose