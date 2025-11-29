# Claude Loop Dashboard

Complete dashboard solution for monitoring and controlling Claude loop automation.

## 🎯 The One Dashboard To Rule Them All

**`claude-loop-unified-dashboard.js`** - The final, complete solution (Port 3335)

## Quick Start

```bash
./start-dashboard.sh
```

Access at: **http://192.168.1.2:3335**

## ✨ Features

### Real-Time Controls
- **Delay adjustment** - Change message interval without restarting
- **Custom messages** - Edit and send messages on-the-fly
- **Context monitoring** - Live context usage meter with color coding
- **Start/Stop/Pause/Resume** - Full loop control from UI

### Smart Context Management
- Automatic context percentage calculation
- Warning/critical thresholds (customizable)
- Tracks lines since last `/compact`
- Sends appropriate messages based on context level

### Configuration (All Adjustable Live!)
- Message delay (1-60 minutes)
- Context-aware mode toggle
- Warning threshold (default 20%)
- Critical threshold (default 10%)
- Scheduled start time (optional)
- Custom message templates

### Persistent Settings
- All configurations saved to `loop-config.json`
- Survives dashboard restarts
- No need to edit shell scripts

## File Organization

```
dashboard/
├── claude-loop-unified-dashboard.js  # The main dashboard (USE THIS!)
├── start-dashboard.sh               # Quick start script
├── loop-config.json                # Saved settings (auto-created)
│
└── archive/                        # Old prototypes (for reference)
    ├── claude-loop-dashboard.js
    ├── claude-loop-dashboard-simple.js
    └── claude-loop-dashboard-enhanced.js
```

## Why This Is Better

Instead of:
- Editing shell scripts to change messages ❌
- Stopping loops to adjust timing ❌
- Guessing context usage ❌
- Managing multiple scripts ❌

You get:
- One dashboard with all controls ✅
- Change anything without restarts ✅
- See exactly how much context remains ✅
- Everything in one place ✅

## Stop Dashboard

```bash
pkill -f "claude-loop-unified-dashboard.js"
```