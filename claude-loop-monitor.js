#!/usr/bin/env node

/**
 * Claude Loop Monitor
 * Monitors Claude loop output for usage limit messages and pauses appropriately
 * Also handles log rotation when logs get too large
 */

const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');

const CONFIG = {
  maxLogSize: 1 * 1024 * 1024, // 10MB - rotate logs when they exceed this
  logCheckInterval: 30000, // Check log size every 30 seconds
  limitCheckInterval: 5000, // Check for usage limit messages every 5 seconds
  logDir: path.join(__dirname, '..', 'tmp', 'claudeLogs'),
  currentLogFile: path.join(__dirname, '..', 'tmp', 'claude_current.log'),
  logsToKeep: 1000
};

// Regular expressions for detecting usage limit messages
const LIMIT_PATTERNS = [
  /Claude usage limit reached.*reset at (\d+)(?:am|pm)/i,
  /Your limit will reset at (\d+):(\d+)(?:am|pm)/i,
  /Rate limit exceeded.*Try again at (\d+):(\d+)/i,
  /Usage quota exceeded.*Available again at (\d+)/i
];

class ClaudeLoopMonitor {
  constructor() {
    this.isRunning = false;
    this.isPaused = false;
    this.logWatcher = null;
    this.sizeChecker = null;
  }

  async start() {
    console.log('🚀 Starting Claude Loop Monitor...\n');
    
    // Ensure log directory exists
    await fs.mkdir(CONFIG.logDir, { recursive: true });
    
    // Start monitoring
    this.isRunning = true;
    this.startLogSizeMonitor();
    this.startUsageLimitMonitor();
    
    console.log('✅ Monitor started. Watching for:');
    console.log('   - Usage limit messages');
    console.log('   - Log size (will rotate at 10MB)');
    console.log('   - Press Ctrl+C to stop\n');
  }

  startLogSizeMonitor() {
    this.sizeChecker = setInterval(async () => {
      try {
        const stats = await fs.stat(CONFIG.currentLogFile);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
        
        if (stats.size > CONFIG.maxLogSize) {
          console.log(`\n📊 Log size: ${sizeMB}MB - Rotating...`);
          await this.rotateLog();
        }
      } catch (err) {
        // Log file doesn't exist yet, that's ok
      }
    }, CONFIG.logCheckInterval);
  }

  startUsageLimitMonitor() {
    // Tail the log file for usage limit messages
    const tail = spawn('tail', ['-f', CONFIG.currentLogFile]);
    
    tail.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      
      for (const line of lines) {
        // Check for usage limit messages
        for (const pattern of LIMIT_PATTERNS) {
          const match = line.match(pattern);
          if (match) {
            console.log('\n⚠️  Usage limit detected!');
            console.log(`   Message: "${line.trim()}"`);
            this.handleUsageLimit(match);
            break;
          }
        }
      }
    });
    
    tail.on('error', (err) => {
      console.error('Error tailing log:', err.message);
    });
    
    this.logWatcher = tail;
  }

  handleUsageLimit(match) {
    // Extract reset time from the match
    let resetHour = parseInt(match[1]);
    const resetMinute = match[2] ? parseInt(match[2]) : 0;
    
    // Determine if it's AM or PM from the original message
    const isPM = match[0].toLowerCase().includes('pm');
    if (isPM && resetHour !== 12) {
      resetHour += 12;
    } else if (!isPM && resetHour === 12) {
      resetHour = 0;
    }
    
    // Calculate wait time
    const now = new Date();
    const resetTime = new Date();
    resetTime.setHours(resetHour, resetMinute, 0, 0);
    
    // If reset time is in the past, assume it's tomorrow
    if (resetTime <= now) {
      resetTime.setDate(resetTime.getDate() + 1);
    }
    
    const waitMs = resetTime - now;
    const waitMinutes = Math.ceil(waitMs / 60000);
    
    console.log(`   Reset time: ${resetTime.toLocaleTimeString()}`);
    console.log(`   Wait time: ${waitMinutes} minutes`);
    console.log(`\n⏸️  Pausing Claude loop until ${resetTime.toLocaleTimeString()}...`);
    
    // Pause the loop
    this.pauseLoop(waitMs);
  }

  pauseLoop(waitMs) {
    this.isPaused = true;
    
    // Send signal to pause the claude loop (if it's running)
    try {
      process.kill(process.pid, 'SIGUSR1'); // Custom signal for pause
    } catch (err) {
      // Loop might not be running
    }
    
    // Set timer to resume
    setTimeout(() => {
      console.log('\n▶️  Resuming Claude loop...');
      this.isPaused = false;
      
      // Send signal to resume
      try {
        process.kill(process.pid, 'SIGUSR2'); // Custom signal for resume
      } catch (err) {
        // Loop might not be running
      }
    }, waitMs);
  }

  async rotateLog() {
    try {
      // Generate timestamp for archived log
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const archivePath = path.join(CONFIG.logDir, `claude_${timestamp}.log`);
      
      // Move current log to archive
      await fs.rename(CONFIG.currentLogFile, archivePath);
      
      // Create new empty log file
      await fs.writeFile(CONFIG.currentLogFile, '');
      
      console.log(`   ✅ Log rotated to: ${path.basename(archivePath)}`);
      
      // Clean up old logs (keep last 10)
      await this.cleanupOldLogs();
      
    } catch (err) {
      console.error('   ❌ Error rotating log:', err.message);
    }
  }

  async cleanupOldLogs() {
    try {
      const files = await fs.readdir(CONFIG.logDir);
      const logFiles = files
        .filter(f => f.startsWith('claude_') && f.endsWith('.log'))
        .sort()
        .reverse();
      
      // Delete logs beyond the 10 most recent
      for (let i = CONFIG.logsToKeep; i < logFiles.length; i++) {
        await fs.unlink(path.join(CONFIG.logDir, logFiles[i]));
        console.log(`   🗑️  Deleted old log: ${logFiles[i]}`);
      }
    } catch (err) {
      console.error('   ⚠️  Error cleaning up logs:', err.message);
    }
  }

  stop() {
    console.log('\n🛑 Stopping Claude Loop Monitor...');
    
    if (this.logWatcher) {
      this.logWatcher.kill();
    }
    
    if (this.sizeChecker) {
      clearInterval(this.sizeChecker);
    }
    
    this.isRunning = false;
    process.exit(0);
  }
}

// Main
const monitor = new ClaudeLoopMonitor();

// Handle graceful shutdown
process.on('SIGINT', () => monitor.stop());
process.on('SIGTERM', () => monitor.stop());

// Start monitoring
monitor.start().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});