#!/usr/bin/env node

/**
 * Optimized Claude Loop Monitor with Efficient Idle Detection
 * Performance improvements:
 * - Caches idle detection method to avoid repeated shell command discovery
 * - Only captures minimal tmux content when idle
 * - Uses lightweight content checks before full captures
 * - Reduced memory allocations during content processing
 * - Batched file operations
 */

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const CONFIG = {
  maxLogSize: 1 * 1024 * 1024, // 1MB
  checkIntervalActive: 2000, // 2 seconds when active (increased from 1s)
  checkIntervalIdle: 15000, // 15 seconds when idle
  checkIntervalMaxIdle: 60000, // 60 seconds when long idle
  userIdleThresholdMinutes: 2,
  userLongIdleThresholdMinutes: 10,
  logDir: path.join(process.env.HOME, 'InfiniQuest', 'tmp', 'claudeLogs'),
  sessionName: process.env.SESSION_NAME || 'claude',
  pauseFile: '/tmp/claude_loop_paused',
  resumeTimeFile: '/tmp/claude_loop_resume_time',
  // Performance optimizations
  minCaptureLines: 50, // Minimal capture when idle
  maxCaptureLines: 2000, // Full capture when active
  contentCheckMethod: 'tail', // 'tail' or 'full'
};

class OptimizedClaudeMonitor {
  constructor() {
    this.isRunning = false;
    this.lastContentTail = '';
    this.currentLogPath = null;
    this.lastRotationDate = null;
    this.checkInterval = CONFIG.checkIntervalActive;
    this.intervalHandle = null;
    this.idleDetectionMethod = null;
    this.idleState = {
      userPresent: true,
      idleLevel: 0,
      lastCheck: Date.now()
    };
    // Performance tracking
    this.performanceStats = {
      captureCount: 0,
      totalCaptureTime: 0,
      idleCheckCount: 0,
      totalIdleCheckTime: 0
    };
  }

  async start() {
    console.log('🚀 Starting Optimized Claude Loop Monitor...\n');
    
    await fsPromises.mkdir(CONFIG.logDir, { recursive: true });
    
    // Detect idle method once at startup
    this.idleDetectionMethod = await this.detectIdleMethod();
    console.log(`📊 Using idle detection method: ${this.idleDetectionMethod || 'none (always active)'}`);
    
    this.isRunning = true;
    this.currentLogPath = this.getCurrentLogPath();
    this.lastRotationDate = new Date().toDateString();
    
    await this.initializeLog();
    this.startMonitoring();
    
    console.log('✅ Monitor started with optimizations:');
    console.log('   - Cached idle detection method');
    console.log('   - Minimal captures when idle');
    console.log('   - Efficient content checking');
    console.log('   - Performance statistics tracking');
    console.log('');
  }

  getCurrentLogPath() {
    const date = new Date().toISOString().split('T')[0];
    return path.join(CONFIG.logDir, `claude_${date}_current.txt`);
  }

  async detectIdleMethod() {
    // Try methods in order of efficiency
    const methods = [
      { name: 'xprintidle', test: async () => { await execPromise('which xprintidle'); return true; }},
      { name: 'xssstate', test: async () => { await execPromise('which xssstate'); return true; }},
      { name: 'loginctl', test: async () => { 
        const { stdout } = await execPromise('loginctl --no-pager list-sessions 2>/dev/null || echo ""');
        return stdout.trim().length > 0;
      }}
    ];

    for (const method of methods) {
      try {
        if (await method.test()) {
          return method.name;
        }
      } catch (e) {}
    }
    
    return null;
  }

  async getUserIdleTime() {
    const startTime = Date.now();
    let idleMs = 0;

    try {
      switch (this.idleDetectionMethod) {
        case 'xprintidle':
          const { stdout } = await execPromise('xprintidle 2>/dev/null');
          idleMs = parseInt(stdout.trim()) || 0;
          break;
          
        case 'xssstate':
          const { stdout: xssOut } = await execPromise('xssstate -i 2>/dev/null');
          idleMs = parseInt(xssOut.trim()) || 0;
          break;
          
        case 'loginctl':
          const { stdout: loginOut } = await execPromise(
            'loginctl show-session $(loginctl list-sessions --no-pager | grep $(whoami) | head -1 | awk \'{print $1}\') -p IdleSinceHint --no-pager 2>/dev/null'
          );
          if (loginOut && loginOut.includes('IdleSinceHint=')) {
            const idleTime = loginOut.replace('IdleSinceHint=', '').trim();
            if (idleTime && idleTime !== '0') {
              const idleDate = new Date(idleTime);
              idleMs = Date.now() - idleDate.getTime();
            }
          }
          break;
          
        default:
          // No idle detection available
          idleMs = 0;
      }
    } catch (error) {
      // Assume active on error
      idleMs = 0;
    }

    // Track performance
    this.performanceStats.idleCheckCount++;
    this.performanceStats.totalIdleCheckTime += Date.now() - startTime;

    return idleMs;
  }

  async updateIdleState() {
    if (!this.idleDetectionMethod) {
      this.idleState.idleLevel = 0;
      return;
    }

    const idleMs = await this.getUserIdleTime();
    const idleMinutes = idleMs / 60000;
    
    const previousLevel = this.idleState.idleLevel;
    
    if (idleMinutes < CONFIG.userIdleThresholdMinutes) {
      this.idleState.userPresent = true;
      this.idleState.idleLevel = 0;
    } else if (idleMinutes < CONFIG.userLongIdleThresholdMinutes) {
      this.idleState.userPresent = false;
      this.idleState.idleLevel = 1;
    } else {
      this.idleState.userPresent = false;
      this.idleState.idleLevel = 2;
    }
    
    // Update check interval
    const intervals = [
      CONFIG.checkIntervalActive,
      CONFIG.checkIntervalIdle,
      CONFIG.checkIntervalMaxIdle
    ];
    
    const newInterval = intervals[this.idleState.idleLevel];
    
    if (Math.abs(newInterval - this.checkInterval) > 500) {
      this.checkInterval = newInterval;
      if (this.intervalHandle) {
        clearInterval(this.intervalHandle);
        this.startMonitoring();
      }
      
      if (previousLevel !== this.idleState.idleLevel) {
        const states = ['Active', 'Idle', 'Long Idle'];
        console.log(`🔄 User ${states[this.idleState.idleLevel]} (${idleMinutes.toFixed(1)}min idle, ${this.checkInterval/1000}s interval)`);
      }
    }
    
    this.idleState.lastCheck = Date.now();
  }

  async captureContent(lines = CONFIG.maxCaptureLines) {
    const startTime = Date.now();
    
    try {
      const { stdout } = await execPromise(
        `tmux capture-pane -pt "${CONFIG.sessionName}" -S -${lines} 2>/dev/null || echo ""`
      );
      
      // Track performance
      this.performanceStats.captureCount++;
      this.performanceStats.totalCaptureTime += Date.now() - startTime;
      
      return stdout;
    } catch (err) {
      return '';
    }
  }

  async getTailContent() {
    // Get just the last few lines for quick comparison
    try {
      const { stdout } = await execPromise(
        `tmux capture-pane -pt "${CONFIG.sessionName}" -S -10 2>/dev/null | tail -5`
      );
      return stdout.trim();
    } catch (err) {
      return '';
    }
  }

  async initializeLog() {
    try {
      const exists = fs.existsSync(this.currentLogPath);
      if (exists) {
        // Get tail of existing log for comparison
        const { stdout } = await execPromise(`tail -5 "${this.currentLogPath}" 2>/dev/null || echo ""`);
        this.lastContentTail = stdout.trim();
        console.log(`📄 Continuing existing log`);
      } else {
        // Create new log
        const content = await this.captureContent();
        await fsPromises.writeFile(this.currentLogPath, content);
        const lines = content.split('\n');
        this.lastContentTail = lines.slice(-5).join('\n').trim();
        console.log(`📄 Created new log file`);
      }
    } catch (err) {
      console.error('Error initializing log:', err.message);
    }
  }

  async appendNewContent() {
    try {
      // First do a quick tail check
      const currentTail = await this.getTailContent();
      
      // If tail hasn't changed and we're idle, skip full capture
      if (currentTail === this.lastContentTail && this.idleState.idleLevel > 0) {
        return;
      }
      
      // Capture content based on user state
      const captureLines = this.idleState.idleLevel === 0 ? 
        CONFIG.maxCaptureLines : CONFIG.minCaptureLines;
      
      const content = await this.captureContent(captureLines);
      if (!content) return;
      
      // Efficient append strategy
      if (this.idleState.idleLevel === 0) {
        // Active user: full append logic
        await this.smartAppend(content);
      } else {
        // Idle user: just append new lines
        const newLines = content.split('\n').slice(-20);
        if (newLines.length > 0) {
          await fsPromises.appendFile(this.currentLogPath, '\n' + newLines.join('\n'));
        }
      }
      
      // Update tail for next comparison
      const lines = content.split('\n');
      this.lastContentTail = lines.slice(-5).join('\n').trim();
      
    } catch (err) {
      console.error('Error appending content:', err.message);
    }
  }

  async smartAppend(content) {
    // Read last 100 lines of log for overlap detection
    const { stdout: logTail } = await execPromise(
      `tail -100 "${this.currentLogPath}" 2>/dev/null || echo ""`
    );
    
    const contentLines = content.split('\n');
    const logLines = logTail.split('\n');
    
    // Find overlap
    let overlapIndex = -1;
    for (let i = Math.max(0, logLines.length - 20); i < logLines.length; i++) {
      const chunk = logLines.slice(i, i + 5).join('\n');
      const idx = content.indexOf(chunk);
      if (idx !== -1) {
        const linesBefore = content.substring(0, idx).split('\n').length - 1;
        overlapIndex = linesBefore + (logLines.length - i);
        break;
      }
    }
    
    // Append only new content
    if (overlapIndex > 0 && overlapIndex < contentLines.length) {
      const newLines = contentLines.slice(overlapIndex);
      if (newLines.length > 0) {
        await fsPromises.appendFile(this.currentLogPath, '\n' + newLines.join('\n'));
        
        // Only log when active
        if (this.idleState.idleLevel === 0) {
          console.log(`📝 Appended ${newLines.length} new lines`);
        }
      }
    }
  }

  async checkAndRotate() {
    const now = new Date();
    const currentDate = now.toDateString();
    
    // Check midnight rotation
    if (currentDate !== this.lastRotationDate) {
      await this.rotateLog('daily');
      this.lastRotationDate = currentDate;
      this.currentLogPath = this.getCurrentLogPath();
      return;
    }
    
    // Check size rotation
    try {
      const stats = await fsPromises.stat(this.currentLogPath);
      if (stats.size > CONFIG.maxLogSize) {
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
        console.log(`📊 Log size ${sizeMB}MB exceeds limit`);
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
      const rotatedName = `claude_${date}_${timestamp}_${reason}.txt`;
      const rotatedPath = path.join(CONFIG.logDir, rotatedName);
      
      await fsPromises.rename(this.currentLogPath, rotatedPath);
      console.log(`✅ Log rotated to: ${rotatedName}`);
      
      // Start new log with minimal content
      const content = await this.captureContent(100);
      await fsPromises.writeFile(this.currentLogPath, content);
      
      const lines = content.split('\n');
      this.lastContentTail = lines.slice(-5).join('\n').trim();
      
      // Clean old logs
      await this.cleanupOldLogs();
    } catch (err) {
      console.error('Error rotating log:', err.message);
    }
  }

  async cleanupOldLogs() {
    try {
      const files = await fsPromises.readdir(CONFIG.logDir);
      const logs = files
        .filter(f => f.startsWith('claude_') && f.endsWith('.txt') && !f.includes('current'))
        .map(f => ({
          name: f,
          path: path.join(CONFIG.logDir, f),
          time: fs.statSync(path.join(CONFIG.logDir, f)).mtime
        }))
        .sort((a, b) => b.time - a.time);
      
      // Keep last 20 logs
      const toDelete = logs.slice(20);
      for (const file of toDelete) {
        await fsPromises.unlink(file.path);
      }
      
      if (toDelete.length > 0) {
        console.log(`🗑️  Cleaned up ${toDelete.length} old logs`);
      }
    } catch (err) {
      // Ignore cleanup errors
    }
  }

  async checkForUsageLimit() {
    // Skip when idle
    if (this.idleState.idleLevel > 0) return false;
    
    try {
      // Get last 50 lines efficiently
      const { stdout } = await execPromise(
        `tmux capture-pane -pt "${CONFIG.sessionName}" -S -50 2>/dev/null | tail -30`
      );
      
      const patterns = [
        /usage limit.*?(\d{1,2}):(\d{2})\s*(am|pm)/i,
        /try again at.*?(\d{1,2}):(\d{2})\s*(am|pm)/i
      ];
      
      for (const line of stdout.split('\n')) {
        for (const pattern of patterns) {
          const match = line.match(pattern);
          if (match) {
            console.log(`⚠️  Usage limit detected: "${line.trim()}"`);
            
            // Parse time and signal pause
            let hour = parseInt(match[1]);
            const minute = parseInt(match[2]);
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
            
            return true;
          }
        }
      }
    } catch (err) {
      // Ignore errors
    }
    
    return false;
  }

  startMonitoring() {
    this.intervalHandle = setInterval(async () => {
      if (!this.isRunning) return;
      
      // Update idle state
      await this.updateIdleState();
      
      // Append new content
      await this.appendNewContent();
      
      // Check for rotation
      await this.checkAndRotate();
      
      // Check usage limits
      await this.checkForUsageLimit();
      
      // Log performance stats every 100 checks
      if (this.performanceStats.captureCount % 100 === 0 && this.performanceStats.captureCount > 0) {
        const avgCaptureTime = (this.performanceStats.totalCaptureTime / this.performanceStats.captureCount).toFixed(1);
        const avgIdleTime = (this.performanceStats.totalIdleCheckTime / this.performanceStats.idleCheckCount).toFixed(1);
        console.log(`📊 Performance: Avg capture ${avgCaptureTime}ms, idle check ${avgIdleTime}ms`);
      }
      
    }, this.checkInterval);
  }

  async stop() {
    console.log('\n🛑 Stopping monitor...');
    this.isRunning = false;
    
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
    }
    
    // Final append
    await this.appendNewContent();
    
    // Log final stats
    if (this.performanceStats.captureCount > 0) {
      const avgCaptureTime = (this.performanceStats.totalCaptureTime / this.performanceStats.captureCount).toFixed(1);
      const avgIdleTime = (this.performanceStats.totalIdleCheckTime / this.performanceStats.idleCheckCount).toFixed(1);
      console.log(`📊 Final stats: ${this.performanceStats.captureCount} captures (avg ${avgCaptureTime}ms), ${this.performanceStats.idleCheckCount} idle checks (avg ${avgIdleTime}ms)`);
    }
    
    console.log('✅ Monitor stopped');
    process.exit(0);
  }
}

// Main execution
const monitor = new OptimizedClaudeMonitor();

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