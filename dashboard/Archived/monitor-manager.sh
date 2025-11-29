#!/bin/bash

# Monitor Manager - Prevents runaway memory usage in log monitors

MONITOR_DIR="/tmp/claude-monitors"
MAX_MEMORY_MB=500  # Kill if process exceeds 500MB
CHECK_INTERVAL=60  # Check every minute

mkdir -p "$MONITOR_DIR"

echo "🔍 Claude Monitor Manager starting..."
echo "📊 Memory limit: ${MAX_MEMORY_MB}MB"
echo "⏱️  Check interval: ${CHECK_INTERVAL}s"
echo ""

while true; do
    # Find all node processes related to claude monitoring
    PIDS=$(pgrep -f "node.*claude.*monitor" || true)
    
    if [ -z "$PIDS" ]; then
        echo "$(date): No monitor processes found"
    else
        for PID in $PIDS; do
            if [ -e /proc/$PID/status ]; then
                # Get memory usage in KB
                MEMORY_KB=$(grep VmRSS /proc/$PID/status | awk '{print $2}')
                MEMORY_MB=$((MEMORY_KB / 1024))
                
                # Get process name
                PROCESS_NAME=$(ps -p $PID -o comm= 2>/dev/null || echo "unknown")
                
                echo "$(date): PID $PID ($PROCESS_NAME) - Memory: ${MEMORY_MB}MB"
                
                if [ $MEMORY_MB -gt $MAX_MEMORY_MB ]; then
                    echo "⚠️  WARNING: Process $PID exceeds memory limit (${MEMORY_MB}MB > ${MAX_MEMORY_MB}MB)"
                    echo "🔪 Killing process..."
                    kill -15 $PID
                    sleep 2
                    
                    # Force kill if still running
                    if kill -0 $PID 2>/dev/null; then
                        echo "🔪 Force killing process..."
                        kill -9 $PID
                    fi
                    
                    echo "✅ Process terminated"
                    
                    # Log the incident
                    echo "$(date): Killed runaway process $PID (${MEMORY_MB}MB)" >> "$MONITOR_DIR/memory-kills.log"
                fi
            fi
        done
    fi
    
    sleep $CHECK_INTERVAL
done