#!/usr/bin/env node

/**
 * Improved Claude Log Monitor - Memory efficient with proper log deduplication
 * Based on the efficient logic from log-monitor.sh
 */

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const CONFIG = {
  maxLogSize: 10 * 1024 * 1024, // 10MB max log size before rotation
  checkIntervalActive: 1000, // 1 second when active
  checkIntervalIdle: 5000, // 5 seconds when idle
  checkIntervalMaxIdle: 30000, // 30 seconds when very idle
  userIdleThresholdMinutes: 2,
  userLongIdleThresholdMinutes: 6,
  logDir: path.join(process.env.HOME, 'InfiniQuest', 'tmp', 'claudeLogs'),
  ansiLogDir: path.join(process.env.HOME, 'InfiniQuest', 'tmp', 'claudeLogs', 'ANSI_tmp'),
  sessionName: process.env.SESSION_NAME || 'claude-loop1',
  cropLines: 50, // How many lines to remove from log before comparison
  referenceLines: 10, // How many lines to use for finding overlap
  maxCaptureLines: 500, // Maximum lines to capture from tmux
};

class ImprovedClaudeMonitor {
  constructor() {
    this.isRunning = false;
    this.currentLogPath = null;
    this.currentAnsiLogPath = null;
    this.checkInterval = CONFIG.checkIntervalActive;
    this.intervalHandle = null;
    this.idleState = {
      level: 0, // 0=active, 1=idle, 2=very idle
      lastCheck: Date.now()
    };
  }

  async start() {
    console.log(`📝 Starting improved log monitor (instance: ${CONFIG.sessionName})...`);
    console.log(`   • Watching tmux session: ${CONFIG.sessionName}`);
    console.log(`   • Clean logs: ${CONFIG.logDir}`);
    console.log(`   • ANSI logs: ${CONFIG.ansiLogDir}`);
    console.log(`   • PID: ${process.pid}`);
    console.log('');
    
    this.isRunning = true;
    
    // Ensure directories exist
    await fsPromises.mkdir(CONFIG.logDir, { recursive: true });
    await fsPromises.mkdir(CONFIG.ansiLogDir, { recursive: true });
    
    // Set up log paths
    this.updateLogPaths();
    
    // Main loop
    this.scheduleNextCheck();
    
    // Handle graceful shutdown
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
  }

  updateLogPaths() {
    const date = new Date().toISOString().split('T')[0];
    this.currentLogPath = path.join(CONFIG.logDir, `${CONFIG.sessionName}_${date}.log`);
    this.currentAnsiLogPath = path.join(CONFIG.ansiLogDir, `${CONFIG.sessionName}.log`);
  }

  scheduleNextCheck() {
    if (!this.isRunning) return;
    
    this.intervalHandle = setTimeout(async () => {
      await this.checkAndUpdateLogs();
      this.scheduleNextCheck();
    }, this.checkInterval);
  }

  async checkAndUpdateLogs() {
    try {
      // Update idle state
      await this.updateIdleState();
      
      // Check if tmux session exists
      const { stdout: sessions } = await execPromise('tmux list-sessions -F "#{session_name}"').catch(() => ({ stdout: '' }));
      if (!sessions.includes(CONFIG.sessionName)) {
        console.log(`Session ${CONFIG.sessionName} not found`);
        return;
      }
      
      // Capture tmux output (both clean and ANSI)
      const [cleanContent, ansiContent] = await Promise.all([
        this.captureTmuxContent(false),
        this.captureTmuxContent(true)
      ]);
      
      if (!cleanContent) return;
      
      // Update ANSI file (always full replacement)
      await fsPromises.writeFile(this.currentAnsiLogPath, ansiContent);
      
      // Update clean log file using efficient crop-filter-append logic
      await this.updateCleanLog(cleanContent);
      
    } catch (err) {
      console.error('Error in check cycle:', err.message);
    }
  }

  async captureTmuxContent(withAnsi = false) {
    const ansiFlag = withAnsi ? '-e' : '';
    const cmd = `tmux capture-pane -t "${CONFIG.sessionName}:0.0" -p ${ansiFlag} -S -${CONFIG.maxCaptureLines}`;
    
    try {
      const { stdout } = await execPromise(cmd);
      return stdout;
    } catch (err) {
      return '';
    }
  }

  async updateCleanLog(newContent) {
    // Check if log file exists
    let logExists = false;
    try {
      await fsPromises.access(this.currentLogPath);
      logExists = true;
    } catch (err) {
      // File doesn't exist yet
    }
    
    if (!logExists) {
      // First run, just write the content
      await fsPromises.writeFile(this.currentLogPath, newContent);
      return;
    }
    
    // Read existing log content
    const logContent = await fsPromises.readFile(this.currentLogPath, 'utf8');
    const logLines = logContent.split('\n');
    
    // Crop last N lines from log
    let croppedLog = logContent;
    if (logLines.length > CONFIG.cropLines) {
      croppedLog = logLines.slice(0, -CONFIG.cropLines).join('\n');
    }
    
    // Get reference lines from the cropped log (last N non-empty lines)
    const referenceLines = croppedLog
      .split('\n')
      .filter(line => line.trim())
      .slice(-CONFIG.referenceLines);
    
    if (referenceLines.length === 0) {
      // No reference, append last 100 lines from tmux
      const newLines = newContent.split('\n').slice(-100);
      await fsPromises.appendFile(this.currentLogPath, '\n' + newLines.join('\n'));
      return;
    }
    
    // Normalize content for comparison (replace numbers with X)
    const normalizedReference = referenceLines.map(line => line.replace(/\d/g, 'X')).join('\n');
    const tmuxLines = newContent.split('\n');
    
    // Find where reference appears in tmux output
    let foundAt = -1;
    for (let i = 0; i <= tmuxLines.length - referenceLines.length; i++) {
      const tmuxBlock = tmuxLines
        .slice(i, i + referenceLines.length)
        .map(line => line.replace(/\d/g, 'X'))
        .join('\n');
      
      if (tmuxBlock === normalizedReference) {
        foundAt = i + referenceLines.length;
        break;
      }
    }
    
    // Append new content
    if (foundAt > 0 && foundAt < tmuxLines.length) {
      const newLines = tmuxLines.slice(foundAt);
      if (newLines.length > 0) {
        await fsPromises.writeFile(this.currentLogPath, croppedLog + '\n' + newLines.join('\n'));
      }
    } else {
      // Didn't find reference, tmux has probably scrolled
      // Append the last 50 lines to avoid losing content
      const newLines = tmuxLines.slice(-50);
      await fsPromises.writeFile(this.currentLogPath, croppedLog + '\n' + newLines.join('\n'));
    }
    
    // Check log size and rotate if needed
    const stats = await fsPromises.stat(this.currentLogPath);
    if (stats.size > CONFIG.maxLogSize) {
      await this.rotateLog();
    }
  }

  async updateIdleState() {
    // Check system idle time
    let idleMs = 0;
    try {
      const { stdout } = await execPromise('xprintidle 2>/dev/null').catch(() => ({ stdout: '0' }));
      idleMs = parseInt(stdout.trim()) || 0;
    } catch (err) {
      // xprintidle not available
    }
    
    // Check CPU usage
    let cpuUsage = 0;
    try {
      const { stdout } = await execPromise("top -bn1 | grep 'Cpu(s)' | sed 's/.*, *\\([0-9.]*\\)%* id.*/\\1/' | awk '{print 100 - $1}'");
      cpuUsage = parseFloat(stdout.trim()) || 0;
    } catch (err) {
      // Ignore
    }
    
    const prevLevel = this.idleState.level;
    
    // Determine idle level
    if (idleMs < CONFIG.userIdleThresholdMinutes * 60 * 1000 || cpuUsage > 10) {
      this.idleState.level = 0;
      this.checkInterval = CONFIG.checkIntervalActive;
    } else if (idleMs < CONFIG.userLongIdleThresholdMinutes * 60 * 1000) {
      this.idleState.level = 1;
      this.checkInterval = CONFIG.checkIntervalIdle;
    } else {
      this.idleState.level = 2;
      this.checkInterval = CONFIG.checkIntervalMaxIdle;
    }
    
    // Log state changes
    if (prevLevel !== this.idleState.level) {
      const states = ['🟢 Active', '🟡 Idle', '🔴 Very Idle'];
      console.log(`${states[this.idleState.level]} mode (${this.checkInterval/1000}s interval, idle: ${Math.round(idleMs/1000)}s, CPU: ${cpuUsage.toFixed(1)}%)`);
    }
  }

  async rotateLog() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rotatedPath = this.currentLogPath.replace('.log', `-${timestamp}.log`);
    
    await fsPromises.rename(this.currentLogPath, rotatedPath);
    console.log(`📁 Rotated log to: ${path.basename(rotatedPath)}`);
    
    // Create new empty log
    await fsPromises.writeFile(this.currentLogPath, '');
    
    // Clean old logs (keep last 10)
    const files = await fsPromises.readdir(CONFIG.logDir);
    const sessionLogs = files
      .filter(f => f.startsWith(CONFIG.sessionName) && f.endsWith('.log'))
      .map(f => ({
        name: f,
        path: path.join(CONFIG.logDir, f)
      }))
      .sort((a, b) => b.name.localeCompare(a.name));
    
    const toDelete = sessionLogs.slice(10);
    for (const file of toDelete) {
      await fsPromises.unlink(file.path);
      console.log(`🗑️  Deleted old log: ${file.name}`);
    }
  }

  stop() {
    console.log('\n🛑 Stopping log monitor...');
    this.isRunning = false;
    
    if (this.intervalHandle) {
      clearTimeout(this.intervalHandle);
    }
    
    process.exit(0);
  }
}

// Start the monitor
const monitor = new ImprovedClaudeMonitor();
monitor.start().catch(err => {
  console.error('Failed to start monitor:', err);
  process.exit(1);
});