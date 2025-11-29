# Claude Loop Tools

This directory contains all tools and scripts for managing Claude automation loops.

## Directory Structure

```
claudeLoop/
├── monitoring/          # Real-time monitoring and analysis tools
│   ├── dashboard.js     # Web dashboard (http://localhost:3333)
│   ├── stats-tracker.js # Real-time statistics monitoring
│   └── usage-stats.js   # Historical log analysis
│
├── management/          # Loop management and control
│   ├── instance-manager.js  # Multi-project instance manager
│   ├── log-monitor.js       # Log rotation and monitoring
│   └── cim                  # CLI wrapper for instance manager
│
├── scripts/             # Main loop scripts
│   ├── claude-loop-enhanced-v2.sh  # Primary loop script
│   └── [other loop variations]
│
├── data/                # Configuration and statistics
│   ├── instances.json   # Instance configurations
│   └── usage-stats.json # Usage statistics data
│
└── logs/                # Log files (symlink to ../claudeLogs)
```

## Quick Start

### 1. Start Dashboard
```bash
node monitoring/dashboard.js
# Visit http://localhost:3333
```

### 2. Monitor Statistics
```bash
# Analyze historical logs
node monitoring/usage-stats.js

# Real-time monitoring
node monitoring/stats-tracker.js
```

### 3. Manage Instances
```bash
# List all instances
./management/cim list

# Create new instance
./management/cim create <name> <project-path>

# Start/stop instance
./management/cim start <name>
./management/cim stop <name>
```

### 4. Run Claude Loop
```bash
# Direct execution
./scripts/claude-loop-enhanced-v2.sh

# Or via instance manager
./management/cim start infiniquest
```

## Tools Overview

### Monitoring Tools
- **dashboard.js**: Web-based real-time monitoring dashboard
- **stats-tracker.js**: Console-based live statistics
- **usage-stats.js**: Analyze logs and generate reports

### Management Tools
- **instance-manager.js**: Manage multiple Claude loops for different projects
- **log-monitor.js**: Handle log rotation and cleanup
- **cim**: Convenience CLI wrapper

### Data Files
- **instances.json**: Stores configuration for all Claude loop instances
- **usage-stats.json**: Accumulated usage statistics

## Logs Location
All logs are stored in `../claudeLogs/` with the naming pattern:
- Current: `claude_YYYY-MM-DD_current.txt`
- Rotated: `claude_YYYY-MM-DD_HH-MM-SS_rotated.txt`

## Configuration
Most tools support environment variables:
- `PORT`: Dashboard port (default: 3333)
- `LOG_DIR`: Log directory path
- `SESSION_DIR`: Session summaries path