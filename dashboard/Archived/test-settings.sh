#!/bin/bash

echo "=== Testing Settings Persistence ==="
echo

# 1. Show current config file
echo "1. Current config file contents:"
echo "   delayMinutes: $(grep -o '"delayMinutes":[^,]*' loop-config.json | cut -d: -f2)"
echo

# 2. Update via curl
echo "2. Updating settings via dashboard API..."
curl -s -X PUT http://localhost:3335/api/config \
  -H "Content-Type: application/json" \
  -d '{"delayMinutes": 999, "useStartTime": true, "startTime": "15:30"}' \
  > /dev/null

echo "   Sent: delayMinutes=999, useStartTime=true, startTime=15:30"
echo

# 3. Wait for save
echo "3. Waiting 2 seconds for save..."
sleep 2
echo

# 4. Check if saved
echo "4. Checking config file after update:"
echo "   delayMinutes: $(grep -o '"delayMinutes":[^,]*' loop-config.json | cut -d: -f2)"
echo "   useStartTime: $(grep -o '"useStartTime":[^,]*' loop-config.json | cut -d: -f2)"
echo "   startTime: $(grep -o '"startTime":[^,]*' loop-config.json | cut -d: -f2)"
echo

# 5. Test after "reload" (just get config again)
echo "5. Getting config from API (simulating page reload):"
CONFIG=$(curl -s http://localhost:3335/api/config)
echo "   delayMinutes: $(echo $CONFIG | grep -o '"delayMinutes":[^,]*' | cut -d: -f2)"
echo "   useStartTime: $(echo $CONFIG | grep -o '"useStartTime":[^,]*' | cut -d: -f2)"
echo "   startTime: $(echo $CONFIG | grep -o '"startTime":[^,]*' | cut -d: -f2)"

echo
echo "=== Test Complete ==="