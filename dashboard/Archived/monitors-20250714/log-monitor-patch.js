#!/usr/bin/env node

/**
 * Patched Claude Loop Monitor - Removes Hash Computation
 * Quick fix for performance issues:
 * - Removes hash computation entirely
 * - Uses simple timestamp-based change detection
 * - Reduces capture frequency
 */

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { spawn, exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const CONFIG = {
  maxLogSize: 1 * 1024 * 1024, // 1MB - rotate when exceeded
  checkInterval: 5000, // Check every 5 seconds (reduced from 30)
  logDir: path.join(process.env.HOME, 'InfiniQuest', 'tmp', 'claudeLogs'),
  sessionName: 'claude',
  pauseFile: '/tmp/claude_loop_paused',
  resumeTimeFile: '/tmp/claude_loop_resume_time'
};

class PatchedClaudeMonitor {
  constructor() {
    this.isRunning = false;
    this.lastAppendTime = 0;
    this.currentLogPath = null;
    this.lastRotationDate = null;
  }

  async start() {
    console.log('🚀 Starting Patched Claude Loop Monitor...\n');
    
    await fsPromises.mkdir(CONFIG.logDir, { recursive: true });
    
    this.isRunning = true;
    this.currentLogPath = this.getCurrentLogPath();
    this.lastRotationDate = new Date().toDateString();
    
    await this.initializeLog();
    this.startMonitoring();
    
    console.log('✅ Monitor started with performance fixes:');
    console.log('   - No hash computation');
    console.log('   - Simple timestamp-based detection');
    console.log('   - 5-second check interval');
    console.log('   - Current log:', path.basename(this.currentLogPath));
    console.log('');
  }

  getCurrentLogPath() {
    const date = new Date().toISOString().split('T')[0];
    return path.join(CONFIG.logDir, `claude_${date}_current.txt`);
  }

  async initializeLog() {
    try {
      const exists = fs.existsSync(this.currentLogPath);
      if (!exists) {
        // Create new log with initial content
        const initialContent = await this.captureCurrentTmuxContent();
        await fsPromises.writeFile(this.currentLogPath, initialContent);
        console.log(`📄 Created new log file for today`);
      } else {
        console.log(`📄 Continuing existing log`);
      }
      this.lastAppendTime = Date.now();
    } catch (err) {
      console.error('Error initializing log:', err.message);
    }
  }

  async captureCurrentTmuxContent() {
    try {
      // Only capture last 500 lines (reduced from 2000)
      const { stdout } = await execPromise(
        `tmux capture-pane -pt "${CONFIG.sessionName}" -S -500 2>/dev/null || echo ""`
      );
      return stdout;
    } catch (err) {
      return '';
    }
  }

  async appendNewContent() {
    try {
      // Simple time-based detection - assume new content every interval
      const now = Date.now();
      
      // Get just the last 20 lines from tmux to check for actual changes
      const { stdout: tailCheck } = await execPromise(
        `tmux capture-pane -pt "${CONFIG.sessionName}" -S -20 2>/dev/null | tail -5`
      );
      
      // If tail is empty or unchanged, skip
      if (!tailCheck || tailCheck.trim().length < 10) {
        return;
      }
      
      // Get current content
      const currentContent = await this.captureCurrentTmuxContent();
      const currentLines = currentContent.split('\n');
      
      // Use tail command to get last 100 lines of log file efficiently
      const { stdout: logTail } = await execPromise(
        `tail -100 "${this.currentLogPath}" 2>/dev/null || echo ""`
      );
      const logLines = logTail.split('\n');
      
      // Simple overlap detection
      let overlapIndex = -1;
      const searchStart = Math.max(0, logLines.length - 20);
      
      for (let i = searchStart; i < logLines.length; i++) {
        const chunk = logLines.slice(i, i + 5).join('\n');
        const idx = currentContent.indexOf(chunk);
        if (idx !== -1) {
          const linesBefore = currentContent.substring(0, idx).split('\n').length - 1;
          overlapIndex = linesBefore + (logLines.length - i);
          break;
        }
      }
      
      // Append new content
      if (overlapIndex > 0 && overlapIndex < currentLines.length) {
        const newLines = currentLines.slice(overlapIndex);
        if (newLines.length > 0) {
          await fsPromises.appendFile(this.currentLogPath, '\n' + newLines.join('\n'));
          console.log(`📝 Appended ${newLines.length} new lines`);
          this.lastAppendTime = now;
        }
      } else if (overlapIndex === -1) {
        // No overlap found, append last 50 lines
        const recentLines = currentLines.slice(-50);
        if (recentLines.length > 0) {
          await fsPromises.appendFile(this.currentLogPath, '\n' + recentLines.join('\n'));
          console.log(`📝 Appended ${recentLines.length} recent lines (no overlap)`);
          this.lastAppendTime = now;
        }
      }
      
    } catch (err) {
      console.error('Error appending content:', err.message);
    }
  }

  async checkAndRotate() {
    const now = new Date();
    const currentDate = now.toDateString();
    
    // Check if date changed (midnight rotation)
    if (currentDate !== this.lastRotationDate) {
      console.log('\n🌙 Midnight reached - rotating log...');
      await this.rotateLog('daily');
      this.lastRotationDate = currentDate;
      this.currentLogPath = this.getCurrentLogPath();
      return;
    }
    
    // Check file size
    try {
      const stats = await fsPromises.stat(this.currentLogPath);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      
      if (stats.size > CONFIG.maxLogSize) {
        console.log(`\n📊 Log size ${sizeMB}MB exceeds limit - rotating...`);
        await this.rotateLog('size');
      }
    } catch (err) {
      // File doesn't exist, create it
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
      
      // Start fresh log with last 50 lines
      const { stdout } = await execPromise(
        `tail -50 "${rotatedPath}" 2>/dev/null || echo ""`
      );
      
      await fsPromises.writeFile(this.currentLogPath, stdout);
      console.log(`📄 New log started with 50 lines of context`);
      
      await this.cleanupOldLogs();
      
    } catch (err) {
      console.error('Error rotating log:', err.message);
    }
  }

  async cleanupOldLogs() {
    try {
      const files = await fsPromises.readdir(CONFIG.logDir);
      const logFiles = files
        .filter(f => f.startsWith('claude_') && f.endsWith('.txt') && !f.includes('current'))
        .map(f => ({
          name: f,
          path: path.join(CONFIG.logDir, f),
          time: fs.statSync(path.join(CONFIG.logDir, f)).mtime
        }))
        .sort((a, b) => b.time - a.time);
      
      // Keep last 20 rotated logs
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
    try {
      // Only check last 30 lines for efficiency
      const { stdout } = await execPromise(
        `tmux capture-pane -pt "${CONFIG.sessionName}" -S -30 2>/dev/null || echo ""`
      );
      
      const limitPatterns = [
        /usage limit reached.*?(\d{1,2}):?(\d{0,2})\s*(am|pm)/i,
        /limit will reset at.*?(\d{1,2}):?(\d{0,2})\s*(am|pm)/i,
        /try again at.*?(\d{1,2}):?(\d{0,2})\s*(am|pm)/i
      ];
      
      for (const line of stdout.split('\n')) {
        for (const pattern of limitPatterns) {
          const match = line.match(pattern);
          if (match) {
            console.log('\n⚠️  Usage limit detected!');
            console.log(`   Message: "${line.trim()}"`);
            
            // Parse time and create pause signal
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
            
            // Signal pause
            await fsPromises.writeFile(CONFIG.resumeTimeFile, resumeTime.toISOString());
            await fsPromises.writeFile(CONFIG.pauseFile, '1');
            
            console.log(`   Will resume at: ${resumeTime.toLocaleTimeString()}`);
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
    // Main monitoring loop
    setInterval(async () => {
      if (!this.isRunning) return;
      
      // Append new content
      await this.appendNewContent();
      
      // Check for rotation needs
      await this.checkAndRotate();
      
      // Check for usage limits
      await this.checkForUsageLimit();
      
    }, CONFIG.checkInterval);
  }

  async stop() {
    console.log('\n🛑 Stopping monitor...');
    this.isRunning = false;
    
    // Final save
    await this.appendNewContent();
    
    console.log('✅ Monitor stopped');
    process.exit(0);
  }
}

// Main execution
const monitor = new PatchedClaudeMonitor();

process.on('SIGINT', () => monitor.stop());
process.on('SIGTERM', () => monitor.stop());

monitor.start().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});