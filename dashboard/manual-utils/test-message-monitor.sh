#!/bin/bash

echo "Testing Claude Message Monitor..."
echo ""

# Start the message monitor
echo "1. Starting message monitor..."
./start-message-monitor.sh

sleep 2

# Check status
echo ""
echo "2. Checking status endpoint..."
curl -s http://localhost:3458/status | jq .

echo ""
echo "3. Creating test log entries..."

# Create a test log file with today's date
LOG_DIR="/home/michael/InfiniQuest/tmp/claudeLogs"
LOG_FILE="$LOG_DIR/claude-loop1_$(date +%Y-%m-%d).log"

# Add some test content
echo "[50% used] Claude is processing..." >> "$LOG_FILE"
sleep 1
echo "Thinking... 5 seconds" >> "$LOG_FILE"
sleep 1
echo "Let's compact!" >> "$LOG_FILE"

# Check status again
echo ""
echo "4. Checking status after test entries..."
curl -s http://localhost:3458/status | jq .

# Check the monitor log
echo ""
echo "5. Message monitor log:"
tail -20 /tmp/claude-monitors/message-monitor.log

echo ""
echo "6. Stopping message monitor..."
./stop-message-monitor.sh

echo ""
echo "Test complete!"