#!/bin/bash
# Safely send messages to tmux sessions
# Usage: tmux-send-safe.sh <session> [message]
# If message is not provided, reads from stdin

SESSION="$1"
MESSAGE="$2"
SEND_DELAY="${3:-5}"  # Default to 5 seconds if not provided
RETRY_ENTER="${4:-true}"  # Default to retrying Enter if not provided

if [ -z "$SESSION" ]; then
    echo "Usage: $0 <session> [message]" >&2
    echo "If message is not provided, reads from stdin" >&2
    exit 1
fi

# If no message provided as argument, read from stdin
if [ -z "$MESSAGE" ]; then
    MESSAGE=$(cat)
fi

# Check if session exists
if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "Error: Session '$SESSION' does not exist" >&2
    exit 1
fi

# Method 1: Try using printf to handle special characters
# This preserves newlines, tabs, and other special characters
if printf '%s' "$MESSAGE" | tmux load-buffer -t "$SESSION" - && \
   tmux paste-buffer -t "$SESSION"; then
    # Wait configurable delay to ensure the message is fully processed
    sleep "$SEND_DELAY"
    # Then send Enter
    tmux send-keys -t "$SESSION" Enter
    
    # Retry Enter after 2 seconds if enabled
    if [ "$RETRY_ENTER" = "true" ]; then
        sleep 2
        tmux send-keys -t "$SESSION" Enter
        echo "Message sent successfully using buffer method (with retry)"
    else
        echo "Message sent successfully using buffer method"
    fi
    exit 0
fi

# Method 2: If buffer method fails, use hex encoding
# This is the most reliable but slower method
echo "Buffer method failed, using hex encoding..." >&2

# Convert to hex and send character by character
printf '%s' "$MESSAGE" | od -An -tx1 | tr -d '\n' | \
while read -n2 hex; do
    if [ -n "$hex" ] && [ "$hex" != "  " ]; then
        tmux send-keys -t "$SESSION" -x "$hex"
    fi
done

# Wait configurable delay to ensure the message is fully processed
sleep "$SEND_DELAY"

# Send Enter key
tmux send-keys -t "$SESSION" Enter

# Retry Enter after 2 seconds if enabled
if [ "$RETRY_ENTER" = "true" ]; then
    sleep 2
    tmux send-keys -t "$SESSION" Enter
    echo "Message sent successfully using hex encoding (with retry)"
else
    echo "Message sent successfully using hex encoding"
fi