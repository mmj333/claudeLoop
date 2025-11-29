#!/bin/bash

# Setup tmux session with Claude
# Can create new sessions or attach to existing ones

SESSION_NAME=${1:-"claude-chat"}
ACTION=${2:-"create"} # create, attach, or ensure

# Function to open Claude in browser
open_claude() {
    echo "🌐 Opening Claude in browser..."
    # Try different methods to open browser
    if command -v xdg-open &> /dev/null; then
        xdg-open "https://claude.ai/new" &
    elif command -v open &> /dev/null; then
        open "https://claude.ai/new" &
    elif command -v firefox &> /dev/null; then
        firefox "https://claude.ai/new" &
    elif command -v chrome &> /dev/null; then
        chrome "https://claude.ai/new" &
    else
        echo "⚠️  Could not open browser automatically. Please open: https://claude.ai/new"
    fi
}

# Function to connect VS Code to the project
connect_vscode() {
    if command -v code &> /dev/null; then
        echo "🔗 Opening VS Code..."
        code /home/michael/InfiniQuest &
    else
        echo "⚠️  VS Code not found in PATH"
    fi
}

case "$ACTION" in
    create)
        # Check if session already exists - use exact matching to avoid prefix issues
        # (e.g., claude-loop10 matching claude-loop100)
        if tmux list-sessions -F "#{session_name}" 2>/dev/null | grep -q "^${SESSION_NAME}$"; then
            echo "✅ Session '$SESSION_NAME' already exists"
            # Don't attach when running from web server
            if [ -t 0 ]; then
                tmux attach-session -t "$SESSION_NAME"
            fi
        else
            echo "📝 Creating new tmux session: $SESSION_NAME"
            
            # Check for existing config file to get working directory
            CONFIG_FILE="/home/michael/InfiniQuest/tmp/claudeLoop/dashboard/loop-config-${SESSION_NAME}.json"
            WORKING_DIR="/home/michael/InfiniQuest"  # Default
            
            if [ -f "$CONFIG_FILE" ]; then
                # Extract working directory from config
                CONFIG_DIR=$(cat "$CONFIG_FILE" | jq -r '.workingDirectory // empty')
                if [ -n "$CONFIG_DIR" ] && [ -d "$CONFIG_DIR" ]; then
                    WORKING_DIR="$CONFIG_DIR"
                    echo "📁 Using working directory from config: $WORKING_DIR"
                fi
            fi
            
            # Create new session detached in the working directory
            tmux new-session -d -s "$SESSION_NAME" -n "claude" -c "$WORKING_DIR"
            
            # Send initial message
            tmux send-keys -t "$SESSION_NAME:0" "echo '🤖 Claude Loop Ready!'" Enter
            tmux send-keys -t "$SESSION_NAME:0" "echo '   • Session: $SESSION_NAME'" Enter
            tmux send-keys -t "$SESSION_NAME:0" "echo '   • Directory: $WORKING_DIR'" Enter
            tmux send-keys -t "$SESSION_NAME:0" "echo '   • Dashboard will capture everything'" Enter
            tmux send-keys -t "$SESSION_NAME:0" "echo ''" Enter
            
            # Check if we have a tracked conversation for this session
            TRACKER_RESULT=$(node "$( dirname "$0" )/claude-session-tracker-simple.js" get "$SESSION_NAME" 2>/dev/null)
            
            if [ -n "$TRACKER_RESULT" ] && [ "$TRACKER_RESULT" != "null" ]; then
                # We have a tracked conversation, try to load it
                CONV_ID=$(echo "$TRACKER_RESULT" | jq -r '.conversationId // empty')
                if [ -n "$CONV_ID" ]; then
                    echo "   • Loading tracked conversation: $CONV_ID"
                    # Use claude --resume with specific conversation ID
                    tmux send-keys -t "$SESSION_NAME:0" "claude --resume $CONV_ID" Enter
                else
                    # Fallback to resume
                    tmux send-keys -t "$SESSION_NAME:0" "claude --resume" Enter
                    sleep 1
                    tmux send-keys -t "$SESSION_NAME:0" Enter
                fi
            else
                # No tracked conversation, use resume to show list
                tmux send-keys -t "$SESSION_NAME:0" "claude --resume" Enter
                sleep 1
                # Auto-select the most recent session (first in list)
                tmux send-keys -t "$SESSION_NAME:0" Enter
                
                # Start monitoring for conversation changes
                sleep 2
                node "$( dirname "$0" )/claude-conversation-monitor.js" "$SESSION_NAME" > "/tmp/claude-monitor-${SESSION_NAME}.log" 2>&1 &
                echo "   • Started conversation monitor (PID: $!)"
            fi
            sleep 2
            
            # Send /ide command to connect to VS Code
            tmux send-keys -t "$SESSION_NAME:0" "/ide" Enter
            sleep 0.5
            tmux send-keys -t "$SESSION_NAME:0" Up Enter
            
            # Don't open browser windows - Claude is already in the terminal
            # open_claude
            # connect_vscode
            
            # Only attach if running in terminal
            if [ -t 0 ]; then
                tmux attach-session -t "$SESSION_NAME"
            fi
        fi
        ;;
        
    attach)
        if tmux list-sessions -F "#{session_name}" 2>/dev/null | grep -q "^${SESSION_NAME}$"; then
            tmux attach-session -t "$SESSION_NAME"
        else
            echo "❌ Session '$SESSION_NAME' does not exist"
            echo "💡 Run: $0 $SESSION_NAME create"
            exit 1
        fi
        ;;
        
    ensure)
        # Ensure session exists without attaching - use exact matching
        if tmux list-sessions -F "#{session_name}" 2>/dev/null | grep -q "^${SESSION_NAME}$"; then
            echo "OK: Session '$SESSION_NAME' exists"
        else
            echo "Creating session '$SESSION_NAME'..."
            tmux new-session -d -s "$SESSION_NAME" -n "claude"
            tmux send-keys -t "$SESSION_NAME:0" "echo '🤖 Claude Loop Ready!'" Enter
            
            # Check if we have a tracked conversation for this session
            TRACKER_RESULT=$(node "$( dirname "$0" )/claude-session-tracker-simple.js" get "$SESSION_NAME" 2>/dev/null)
            
            if [ -n "$TRACKER_RESULT" ] && [ "$TRACKER_RESULT" != "null" ]; then
                # We have a tracked conversation, try to load it
                CONV_ID=$(echo "$TRACKER_RESULT" | jq -r '.conversationId // empty')
                if [ -n "$CONV_ID" ]; then
                    echo "   • Loading tracked conversation: $CONV_ID"
                    tmux send-keys -t "$SESSION_NAME:0" "claude --resume $CONV_ID" Enter
                else
                    tmux send-keys -t "$SESSION_NAME:0" "claude --resume" Enter
                    sleep 1
                    tmux send-keys -t "$SESSION_NAME:0" Enter
                fi
            else
                # Launch Claude with resume option
                tmux send-keys -t "$SESSION_NAME:0" "claude --resume" Enter
                sleep 1
                # Auto-select the most recent session (first in list)
                tmux send-keys -t "$SESSION_NAME:0" Enter
                
                # Start monitoring for conversation changes
                sleep 2
                node "$( dirname "$0" )/claude-conversation-monitor.js" "$SESSION_NAME" > "/tmp/claude-monitor-${SESSION_NAME}.log" 2>&1 &
                echo "   • Started conversation monitor (PID: $!)"
            fi
            sleep 2
            tmux send-keys -t "$SESSION_NAME:0" "/ide" Enter
            sleep 0.5
            tmux send-keys -t "$SESSION_NAME:0" Up Enter
            
            echo "OK: Session '$SESSION_NAME' created"
        fi
        ;;
        
    status)
        if tmux list-sessions -F "#{session_name}" 2>/dev/null | grep -q "^${SESSION_NAME}$"; then
            echo "{\"exists\": true, \"session\": \"$SESSION_NAME\"}"
        else
            echo "{\"exists\": false, \"session\": \"$SESSION_NAME\"}"
        fi
        ;;
        
    *)
        echo "Usage: $0 [session_name] {create|attach|ensure|status}"
        echo "  create - Create new session and open Claude/VS Code"
        echo "  attach - Attach to existing session"
        echo "  ensure - Create session if it doesn't exist (no attach)"
        echo "  status - Check if session exists (JSON output)"
        exit 1
        ;;
esac