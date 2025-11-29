# Claude Loop Dashboard Vision V1.0

## Executive Summary
The Claude Loop Dashboard should provide a seamless, intelligent interface for managing Claude AI loop sessions. Users should experience automatic session management, real-time log monitoring with proper ANSI color support, and intuitive controls for multiple concurrent sessions.

### pre-work

1. We should consider refactoring some code from the dashboard into utilities if the dashboard document is getting too long.

## Core User Journey

### 1. Page Load Experience
When a user opens the dashboard (http://192.168.1.2:3335):

1. **Automatic Session Discovery**
   - Dashboard queries existing tmux sessions
   - Identifies all sessions matching pattern `claude-loop*`
   - Assigns the lowest available number (e.g., if `claude-loop2` exists, new session will be `claude-loop1`)

2. **Global Session Variable**
   - Page establishes a global variable like `currentSessionName = "claude-loop1"`
   - All components reference this variable for consistency
   - Session name appears in page title and header

3. **Clean Initial State**
   - Live log window shows "No active monitor - Click 'Start Console Logging' to begin"
   - No unnecessary polling or resource usage
   - Clear visual indicators of session status

### 2. Starting a Session

#### Automatic Claude Launch
When user clicks "Start Claude Loop":
1. Dashboard creates tmux session with the assigned name
2. Automatically launches Claude in the session using proven logic from `claude_continue_loop.sh`:
   - Opens Claude.ai in browser
   - Connects VS Code to the project
   - Sends `/ide` command and connects to the session
   - Shows "Claude Loop Ready!" message in tmux

#### Log Monitoring
When user clicks "Start Console Logging":
1. Log monitor starts for the specific session only
2. Creates two log streams:
   - **ANSI Display Log**: `tmp/claudeLogs/ANSI_tmp/claude-loop1.log` (no date needed)
   - **Clean Archive Log**: `tmp/claudeLogs/claude-loop1_2025-07-09.log` (with date)
3. Live log window immediately begins showing content
4. Visual indicator shows "● Recording" with pulsing animation

### 3. Multi-Session Management

#### Session Tabs/Dropdown
- Clean UI with tabs or dropdown to switch between sessions
- Each tab shows:
  - Session name (claude-loop1, claude-loop2, etc.)
  - Status indicator (● Active, ○ Idle, ■ Stopped)
  - Log monitor status (Recording/Paused/Stopped)

#### Switching Sessions
When user switches sessions:
1. Dashboard updates `currentSessionName` global variable
2. Live log window switches to show new session's ANSI log
3. Control buttons update to affect the selected session
4. No restart of monitors - they continue running independently

#### Adding New Session
"+ New Session" button that:
1. Finds next available number
2. Creates new tmux session
3. Launches Claude automatically
4. Switches view to the new session

### 4. Logging Architecture

#### File Organization
```
tmp/claudeLogs/
├── ANSI_tmp/                    # Live display logs (no dates)
│   ├── claude-loop1.log
│   ├── claude-loop2.log
│   └── claude-loop3.log
└── claude-loop1_2025-07-09.log   # Clean logs with dates
    claude-loop1_2025-07-10.log
    claude-loop2_2025-07-09.log
```

#### Performance Optimization
- Log monitor only captures the active session
- Live log window only polls when monitor is running
- Virtual scrolling for large logs (already implemented)
- Intelligent refresh rates (faster when active, slower when idle)

### 5. Control Integration

#### Essential Controls Per Session
- **Start/Stop Loop**: Controls the Claude message loop
- **Start/Stop Logging**: Controls log capture
- **Pause/Resume**: Temporarily halts the loop
- **Send Message**: Manual message injection
- **Clear Logs**: Clears current session's display

#### Settings That Apply Globally
- Loop delay (minutes between messages)
- Custom message template
- Start time scheduling
- Log rotation settings

### 6. Technical Improvements

#### Fix: Dashboard Not Launching Claude
Integrate the proven logic from `claude_continue_loop.sh`:
```bash
# These keys connect the session to VS Code
tmux send-keys -t "$SESSION_NAME" '/ide'
sleep 0.5
tmux send-keys -t "$SESSION_NAME" Enter
sleep 1.5
tmux send-keys -t "$SESSION_NAME" Up 
sleep 0.5
tmux send-keys -t "$SESSION_NAME" Enter
```

#### Fix: Multi-Session Lag
- Only poll/update the currently viewed session
- Use event-based updates instead of constant polling
- Cache session states to reduce API calls

#### Fix: Session Coordination
- Use log-monitor-manager.sh for centralized monitoring
- Session files track which tmux session each monitor watches
- Prevent duplicate monitors per session

### 7. Error Handling & Recovery

#### Graceful Degradation
- If tmux session dies, show clear error with recovery option
- If log monitor crashes, auto-restart with user notification
- If browser connection fails, provide manual instructions

#### Emergency Controls
- "Kill All Sessions" button (with confirmation)
- Individual session force-stop options
- Log monitor reset per session

### 8. Future Enhancements (Post-V1.0)

- **Session Templates**: Save/load session configurations
- **Log Search**: Real-time search within logs
- **Session Analytics**: Message counts, uptime, usage patterns
- **Export Options**: Download logs in various formats
- **Mobile View**: Responsive design for phone monitoring

## Implementation Priority

### Phase 1: Core Functionality
1. Automatic session naming and management
2. Proper Claude launch in tmux
3. Single-session focused monitoring
4. Clean file organization

### Phase 2: Multi-Session Polish  
1. Session switching UI
2. Performance optimization
3. Error recovery
4. Visual indicators

### Phase 3: Enhanced Features
1. Settings persistence per session
2. Advanced controls
3. Export and analytics

## Success Criteria

The V1.0 dashboard is successful when:
1. User can start a Claude loop with one click
2. Claude actually launches and connects properly
3. Logs display in real-time with proper colors
4. Multiple sessions can run without interference
5. No lag when switching between sessions
6. Clear visual feedback for all states
7. Graceful handling of errors

## Technical Decisions

1. **Keep What Works**: The ANSI parser is good - don't rewrite it
2. **Fix What's Broken**: Claude launch, multi-session lag
3. **Simplify File Naming**: Session name in filename, date only for archives
4. **Resource Efficiency**: Only monitor/poll active sessions
5. **User Control**: Nothing starts automatically except session assignment