#!/usr/bin/env node

/*
 * InfiniQuest - Family Productivity Software
 * Copyright (C) 2025 Michael Johnson <wholeness@infiniquest.app>
 *
 * User-Idle Aware Claude Loop Monitor
 * - Detects actual user presence via keyboard/mouse activity
 * - Slows down when user is away from computer
 * - Reduces system load during user absence
 */

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { spawn, exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const CONFIG = {
  maxLogSize: 1 * 1024 * 1024, // 1MB - rotate when exceeded
  checkIntervalActive: 1000, // 1 second when user present
  checkIntervalIdle: 10000, // 10 seconds when user away
  checkIntervalMaxIdle: 60000, // 60 seconds when user long gone
  userIdleThresholdMinutes: 2, // Minutes of no input to consider user away
  userLongIdleThresholdMinutes: 10, // Minutes for deep idle
  logDir: path.join(process.env.HOME, 'InfiniQuest', 'tmp', 'claudeLogs'),
  sessionName: process.env.SESSION_NAME || 'claude-loop1',
  pauseFile: `/tmp/claude_loop_paused_${process.env.SESSION_NAME || 'claude-loop1'}`,
  resumeTimeFile: `/tmp/claude_loop_resume_time_${process.env.SESSION_NAME || 'claude-loop1'}`,
  configFile: path.join(__dirname, `loop-config-${process.env.SESSION_NAME || 'claude-loop1'}.json`),
  idleStateFile: `/tmp/claude_loop_idle_state_${process.env.SESSION_NAME || 'claude-loop1'}.json`
};

class UserIdleAwareMonitor {
  constructor() {
    this.isRunning = false;
    this.lastContentHash = '';
    this.currentLogPath = null;
    this.lastRotationDate = null;
    this.checkInterval = CONFIG.checkIntervalActive;
    this.intervalHandle = null;
    this.userIdleEnabled = true; // Can be toggled via config
    this.idleState = {
      userPresent: true,
      idleLevel: 0, // 0 = user active, 1 = user idle, 2 = user long gone
      lastUserActivity: Date.now(),
      lastCheck: Date.now()
    };
    this.rateLimitHistory = [];
    this.pauseDebounceTime = 60000;
  }

  async loadConfig() {
    try {
      const configData = await fsPromises.readFile(CONFIG.configFile, 'utf-8');
      const config = JSON.parse(configData);
      
      // Check for user idle settings
      const settings = config.monitorSettings || config;
      
      // Enable/disable user idle detection
      if (settings.userIdleDetection !== undefined) {
        this.userIdleEnabled = settings.userIdleDetection;
      }
      
      // Override intervals if configured
      if (settings.checkIntervalActive) {
        CONFIG.checkIntervalActive = settings.checkIntervalActive * 1000;
      } else if (config.logRefreshRate) {
        CONFIG.checkIntervalActive = config.logRefreshRate * 1000;
      }
      
      if (settings.checkIntervalIdle) {
        CONFIG.checkIntervalIdle = settings.checkIntervalIdle * 1000;
      }
      if (settings.checkIntervalMaxIdle) {
        CONFIG.checkIntervalMaxIdle = settings.checkIntervalMaxIdle * 1000;
      }
      if (settings.userIdleThresholdMinutes) {
        CONFIG.userIdleThresholdMinutes = settings.userIdleThresholdMinutes;
      }
      
      console.log(`📊 Config loaded:`);
      console.log(`   User idle detection: ${this.userIdleEnabled ? 'Enabled' : 'Disabled'}`);
      console.log(`   Active: ${CONFIG.checkIntervalActive/1000}s, Idle: ${CONFIG.checkIntervalIdle/1000}s, Max idle: ${CONFIG.checkIntervalMaxIdle/1000}s`);
      
      return config;
    } catch (error) {
      console.log('📊 Using defaults (config not found)');
      return {};
    }
  }

  async detectIdleMethod() {
    // Try each method to see what's available
    try {
      await execPromise('which xprintidle');
      return 'xprintidle';
    } catch (e) {}
    
    try {
      const { stdout } = await execPromise('gdbus call -e -d org.gnome.ScreenSaver -o /org/gnome/ScreenSaver -m org.gnome.ScreenSaver.GetActiveTime 2>&1');
      if (!stdout.includes('Error')) return 'Gnome ScreenSaver D-Bus';
    } catch (e) {}
    
    try {
      const { stdout } = await execPromise('loginctl show-session $(loginctl | grep $(whoami) | head -1 | awk \'{print $1}\') -p IdleSinceHint 2>&1');
      if (stdout.includes('IdleSinceHint=')) return 'systemd loginctl';
    } catch (e) {}
    
    try {
      await execPromise('which xssstate');
      return 'xssstate';
    } catch (e) {}
    
    try {
      const { stdout } = await execPromise('xset q 2>&1');
      if (!stdout.includes('unable to open display')) return 'xset (monitor status only)';
    } catch (e) {}
    
    return null;
  }

  async getUserIdleTime() {
    try {
      // Method 1: Use xprintidle to get milliseconds since last X11 activity
      const { stdout } = await execPromise('xprintidle 2>/dev/null');
      const idleMs = parseInt(stdout.trim());
      return idleMs;
    } catch (error) {
      // xprintidle not installed, try other methods
    }
    
    try {
      // Method 2: Check Gnome screensaver status via D-Bus
      const { stdout } = await execPromise('gdbus call -e -d org.gnome.ScreenSaver -o /org/gnome/ScreenSaver -m org.gnome.ScreenSaver.GetActiveTime 2>/dev/null');
      if (stdout && stdout.includes('uint32')) {
        const match = stdout.match(/uint32 (\d+)/);
        if (match) {
          return parseInt(match[1]) * 1000; // Convert seconds to ms
        }
      }
    } catch (e) {
      // Not on Gnome
    }
    
    try {
      // Method 3: Check if screen is locked via loginctl
      const { stdout } = await execPromise('loginctl show-session $(loginctl | grep $(whoami) | awk \'{print $1}\') -p IdleSinceHint 2>/dev/null');
      if (stdout && stdout.includes('IdleSinceHint=')) {
        const idleTime = stdout.replace('IdleSinceHint=', '').trim();
        if (idleTime && idleTime !== '0') {
          // Parse systemd timestamp
          const idleDate = new Date(idleTime);
          return Date.now() - idleDate.getTime();
        }
      }
    } catch (e) {
      // loginctl not available
    }
    
    try {
      // Method 4: Check X11 screensaver info
      const { stdout } = await execPromise('xprintidle 2>/dev/null || (xssstate -i 2>/dev/null | grep -o "[0-9]*")');
      if (stdout && stdout.trim()) {
        return parseInt(stdout.trim());
      }
    } catch (e) {
      // No X11 screensaver tools
    }
    
    try {
      // Method 5: Check if monitor is off (power saving)
      const { stdout } = await execPromise('xset q 2>/dev/null | grep "Monitor is" || echo "Monitor is On"');
      if (stdout.includes('Monitor is Off')) {
        // Screen is off, assume user has been away for at least 10 minutes
        return 10 * 60 * 1000;
      }
    } catch (e) {
      // No xset
    }
    
    try {
      // Method 6: Check /proc/interrupts for keyboard/mouse activity
      // This is less accurate but works on most Linux systems
      const { stdout: before } = await execPromise('grep -E "mouse|keyboard|touchpad" /proc/interrupts | awk \'{sum += $2} END {print sum}\' 2>/dev/null');
      await new Promise(resolve => setTimeout(resolve, 100)); // Wait 100ms
      const { stdout: after } = await execPromise('grep -E "mouse|keyboard|touchpad" /proc/interrupts | awk \'{sum += $2} END {print sum}\' 2>/dev/null');
      
      if (before && after && before.trim() === after.trim()) {
        // No interrupts in 100ms, might be idle
        // This is just a hint, not accurate for actual idle time
        return 0; // Can't determine actual idle time this way
      }
    } catch (e) {
      // /proc/interrupts not accessible
    }
    
    // If we can't detect idle time, assume user is present
    return 0;
  }

  async updateUserIdleState() {
    if (!this.userIdleEnabled) {
      // User idle detection disabled, always active
      this.idleState.idleLevel = 0;
      return;
    }

    try {
      const idleMs = await this.getUserIdleTime();
      const idleMinutes = idleMs / 60000;
      
      const previousLevel = this.idleState.idleLevel;
      
      if (idleMinutes < CONFIG.userIdleThresholdMinutes) {
        // User is active
        this.idleState.userPresent = true;
        this.idleState.idleLevel = 0;
        this.idleState.lastUserActivity = Date.now() - idleMs;
      } else if (idleMinutes < CONFIG.userLongIdleThresholdMinutes) {
        // User is idle
        this.idleState.userPresent = false;
        this.idleState.idleLevel = 1;
      } else {
        // User has been away for a while
        this.idleState.userPresent = false;
        this.idleState.idleLevel = 2;
      }
      
      this.idleState.lastCheck = Date.now();
      
      // Adjust interval based on user presence
      let newInterval;
      switch (this.idleState.idleLevel) {
        case 0:
          newInterval = CONFIG.checkIntervalActive;
          break;
        case 1:
          newInterval = CONFIG.checkIntervalIdle;
          break;
        case 2:
          newInterval = CONFIG.checkIntervalMaxIdle;
          break;
      }
      
      // Only restart if interval changed significantly
      if (Math.abs(newInterval - this.checkInterval) > 500) {
        this.checkInterval = newInterval;
        if (this.intervalHandle) {
          clearInterval(this.intervalHandle);
          this.startMonitoring();
        }
        
        if (previousLevel !== this.idleState.idleLevel) {
          const stateNames = ['User Active', 'User Away', 'User Long Gone'];
          console.log(`🔄 ${stateNames[this.idleState.idleLevel]} (${this.checkInterval/1000}s interval, idle: ${idleMinutes.toFixed(1)} min)`);
        }
      }
      
      // Save state
      await fsPromises.writeFile(CONFIG.idleStateFile, JSON.stringify(this.idleState, null, 2)).catch(() => {});
      
    } catch (error) {
      // If we can't detect user idle, assume active
      this.idleState.idleLevel = 0;
    }
  }

  async start() {
    console.log('🚀 Starting User-Idle Aware Claude Loop Monitor...\n');
    
    // Check which idle detection method is available
    const idleMethod = await this.detectIdleMethod();
    if (idleMethod) {
      console.log(`✅ Using ${idleMethod} for user activity detection`);
    } else {
      console.log('⚠️  No idle detection method available');
      console.log('   Install xprintidle with: sudo apt install xprintidle');
      console.log('   Monitor will run without user idle detection');
      this.userIdleEnabled = false;
    }
    
    await fsPromises.mkdir(CONFIG.logDir, { recursive: true });
    await this.loadConfig();
    
    // Try to restore previous state
    try {
      const savedState = await fsPromises.readFile(CONFIG.idleStateFile, 'utf-8');
      const parsed = JSON.parse(savedState);
      if (parsed.lastCheck && Date.now() - parsed.lastCheck < 300000) {
        this.idleState = parsed;
        console.log(`📊 Restored state: User ${this.idleState.userPresent ? 'Present' : 'Away'} (level ${this.idleState.idleLevel})`);
      }
    } catch (error) {
      // No saved state
    }
    
    this.isRunning = true;
    this.currentLogPath = this.getCurrentLogPath();
    this.lastRotationDate = new Date().toDateString();
    
    await this.initializeLog();
    this.startMonitoring();
    
    console.log('✅ Monitor started with user presence detection:');
    console.log('   - User active: 1s refresh');
    console.log('   - User away (2+ min): 10s refresh');
    console.log('   - User long gone (10+ min): 60s refresh');
    console.log('   - Detects keyboard/mouse activity');
    console.log('   - Current log:', path.basename(this.currentLogPath));
    console.log('');
  }

  getCurrentLogPath() {
    const ansiLogDir = path.join(CONFIG.logDir, 'ANSI_tmp');
    fs.mkdirSync(ansiLogDir, { recursive: true });
    return path.join(ansiLogDir, `${CONFIG.sessionName}.log`);
  }

  async initializeLog() {
    try {
      const exists = fs.existsSync(this.currentLogPath);
      if (exists) {
        const content = await fsPromises.readFile(this.currentLogPath, 'utf8');
        this.lastContentHash = this.hashContent(content);
        console.log(`📄 Continuing existing log`);
      } else {
        const initialContent = await this.captureCurrentTmuxContent();
        await fsPromises.writeFile(this.currentLogPath, initialContent);
        this.lastContentHash = this.hashContent(initialContent);
        console.log(`📄 Created new log file`);
      }
    } catch (err) {
      console.error('Error initializing log:', err.message);
    }
  }

  hashContent(content) {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) - hash) + content.charCodeAt(i);
      hash = hash & hash;
    }
    return hash.toString(16);
  }

  async captureCurrentTmuxContent() {
    try {
      const { stdout } = await execPromise(
        `tmux capture-pane -ept "${CONFIG.sessionName}" -S -2000 2>/dev/null || echo ""`
      );
      return stdout;
    } catch (err) {
      return '';
    }
  }

  async appendNewContent() {
    try {
      const currentContent = await this.captureCurrentTmuxContent();
      if (!currentContent) return;
      
      const currentHash = this.hashContent(currentContent);
      
      if (currentHash !== this.lastContentHash) {
        this.lastContentHash = currentHash;
        await fsPromises.writeFile(this.currentLogPath, currentContent);
        
        // Only log updates when user is present
        if (this.idleState.userPresent) {
          const sizeMB = (currentContent.length / 1024 / 1024).toFixed(2);
          console.log(`📝 Updated log (${sizeMB}MB)`);
        }
      }
    } catch (err) {
      console.error('Error syncing content:', err.message);
    }
  }

  async checkAndRotate() {
    const now = new Date();
    const currentDate = now.toDateString();
    
    if (currentDate !== this.lastRotationDate) {
      console.log('\n🌙 Midnight reached - rotating log...');
      await this.rotateLog('daily');
      this.lastRotationDate = currentDate;
      this.currentLogPath = this.getCurrentLogPath();
      return;
    }
    
    try {
      const stats = await fsPromises.stat(this.currentLogPath);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      
      if (stats.size > CONFIG.maxLogSize) {
        console.log(`\n📊 Log size ${sizeMB}MB exceeds limit - rotating...`);
        await this.rotateLog('size');
      }
    } catch (err) {
      await this.initializeLog();
    }
  }

  async rotateLog(reason) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const date = new Date().toISOString().split('T')[0];
      const rotatedName = `${CONFIG.sessionName}_${date}_${timestamp}_${reason}.log`;
      const rotatedPath = path.join(CONFIG.logDir, rotatedName);
      
      await fsPromises.rename(this.currentLogPath, rotatedPath);
      console.log(`✅ Log rotated to: ${rotatedName}`);
      
      const recentContent = await this.captureCurrentTmuxContent();
      const recentLines = recentContent.split('\n');
      const startContent = recentLines.slice(-100).join('\n');
      
      await fsPromises.writeFile(this.currentLogPath, startContent);
      this.lastContentHash = this.hashContent(startContent);
      
      console.log(`📄 New log started with 100 lines of context`);
      await this.cleanupOldLogs();
    } catch (err) {
      console.error('Error rotating log:', err.message);
    }
  }

  async cleanupOldLogs() {
    try {
      const files = await fsPromises.readdir(CONFIG.logDir);
      const logFiles = files
        .filter(f => f.startsWith(CONFIG.sessionName) && f.endsWith('.log') && !f.includes(new Date().toISOString().split('T')[0]))
        .map(f => ({
          name: f,
          path: path.join(CONFIG.logDir, f),
          time: fs.statSync(path.join(CONFIG.logDir, f)).mtime
        }))
        .sort((a, b) => b.time - a.time);
      
      const toDelete = logFiles.slice(20);
      
      for (const file of toDelete) {
        await fsPromises.unlink(file.path);
        console.log(`🗑️  Deleted old log: ${file.name}`);
      }
    } catch (err) {
      console.error('Error cleaning up logs:', err.message);
    }
  }

  async checkForUsageLimit() {
    // Only check when user is present (no point checking when they're away)
    if (!this.idleState.userPresent) return false;
    
    try {
      const content = await this.captureCurrentTmuxContent();
      const recentLines = content.split('\n').slice(-100);
      
      const strongLimitPatterns = [
        /Claude's usage limit.*?(\d{1,2}):(\d{2})\s*(am|pm)/i,
        /You've reached Claude's usage limit.*?(\d{1,2}):(\d{2})\s*(am|pm)/i,
        /Usage limit reached.*?try again at (\d{1,2}):(\d{2})\s*(am|pm)/i
      ];
      
      let matchCount = 0;
      let lastMatch = null;
      
      for (const line of recentLines) {
        for (const pattern of strongLimitPatterns) {
          const match = line.match(pattern);
          if (match) {
            matchCount++;
            lastMatch = { line, match };
          }
        }
      }
      
      if (matchCount >= 2 && lastMatch) {
        const now = Date.now();
        const recentPause = this.rateLimitHistory.find(p => now - p.timestamp < this.pauseDebounceTime);
        if (recentPause) return false;
        
        console.log('\n⚠️  Usage limit detected!');
        console.log(`   Message: "${lastMatch.line.trim()}"`);
        
        const { match } = lastMatch;
        let hour = parseInt(match[1]);
        const minute = match[2] ? parseInt(match[2]) : 0;
        const ampm = match[3];
        
        if (ampm === 'pm' && hour !== 12) hour += 12;
        if (ampm === 'am' && hour === 12) hour = 0;
        
        const resumeTime = new Date();
        resumeTime.setHours(hour, minute, 0, 0);
        
        if (resumeTime <= new Date()) {
          resumeTime.setDate(resumeTime.getDate() + 1);
        }
        
        await fsPromises.writeFile(CONFIG.resumeTimeFile, resumeTime.toISOString());
        await fsPromises.writeFile(CONFIG.pauseFile, '1');
        
        this.rateLimitHistory.push({ timestamp: now, resumeTime });
        if (this.rateLimitHistory.length > 10) {
          this.rateLimitHistory.shift();
        }
        
        console.log(`   Will resume at: ${resumeTime.toLocaleTimeString()}`);
        return true;
      }
    } catch (err) {
      // Ignore errors
    }
    return false;
  }

  startMonitoring() {
    this.intervalHandle = setInterval(async () => {
      if (!this.isRunning) return;
      
      // Update user idle state first
      await this.updateUserIdleState();
      
      // Always update content (but logging is reduced when user away)
      await this.appendNewContent();
      
      // Check for rotation
      await this.checkAndRotate();
      
      // Check for usage limits less frequently when user is away
      if (this.idleState.userPresent || Math.random() < 0.1) {
        await this.checkForUsageLimit();
      }
      
    }, this.checkInterval);
    
    const status = this.userIdleEnabled ? 
      `user presence detection (${this.checkInterval / 1000}s)` : 
      `fixed interval (${this.checkInterval / 1000}s)`;
    console.log(`🔄 Monitoring started with ${status}`);
  }

  async stop() {
    console.log('\n🛑 Stopping monitor...');
    this.isRunning = false;
    
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
    }
    
    await this.appendNewContent();
    await fsPromises.writeFile(CONFIG.idleStateFile, JSON.stringify(this.idleState, null, 2));
    
    console.log('✅ Monitor stopped');
    process.exit(0);
  }
}

// Main execution
const monitor = new UserIdleAwareMonitor();

process.on('SIGINT', () => monitor.stop());
process.on('SIGTERM', () => monitor.stop());
process.on('uncaughtException', (err) => {
  console.error('Uncaught error:', err);
  monitor.stop();
});

monitor.start().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});