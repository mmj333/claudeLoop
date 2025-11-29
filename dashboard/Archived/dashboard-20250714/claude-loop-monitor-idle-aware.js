#!/usr/bin/env node

/*
 * InfiniQuest - Family Productivity Software
 * Copyright (C) 2025 Michael Johnson <wholeness@infiniquest.app>
 *
 * This file is part of InfiniQuest.
 *
 * InfiniQuest is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * InfiniQuest is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with InfiniQuest. If not, see <https://www.gnu.org/licenses/>.
 *
 * For commercial licensing options, visit: https://infiniquest.app/licensing
 */

/**
 * Enhanced Claude Loop Monitor with Idle Detection
 * - Dynamically adjusts refresh rate based on activity
 * - Improved rate limit detection to reduce false positives
 * - Smart log rotation with minimal overhead
 * - CPU usage monitoring for true idle detection
 */

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { spawn, exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const os = require('os');

const CONFIG = {
  maxLogSize: 1 * 1024 * 1024, // 1MB - rotate when exceeded
  checkIntervalActive: 1000, // 1 second when active
  checkIntervalIdle: 5000, // 5 seconds when idle
  checkIntervalMaxIdle: 30000, // 30 seconds when very idle
  idleThresholdMinutes: 2, // Minutes of no new content to consider idle
  cpuIdleThreshold: 0.10, // CPU usage below 10% considered idle
  logDir: path.join(process.env.HOME, 'InfiniQuest', 'tmp', 'claudeLogs'),
  sessionName: process.env.SESSION_NAME || 'claude-loop1',
  pauseFile: `/tmp/claude_loop_paused_${process.env.SESSION_NAME || 'claude-loop1'}`,
  resumeTimeFile: `/tmp/claude_loop_resume_time_${process.env.SESSION_NAME || 'claude-loop1'}`,
  configFile: path.join(__dirname, `loop-config-${process.env.SESSION_NAME || 'claude-loop1'}.json`),
  idleStateFile: `/tmp/claude_loop_idle_state_${process.env.SESSION_NAME || 'claude-loop1'}.json`
};

class IdleAwareClaudeMonitor {
  constructor() {
    this.isRunning = false;
    this.lastContentHash = '';
    this.lastActivityTime = Date.now();
    this.currentLogPath = null;
    this.lastRotationDate = null;
    this.checkInterval = CONFIG.checkIntervalActive;
    this.intervalHandle = null;
    this.idleState = {
      isIdle: false,
      idleLevel: 0, // 0 = active, 1 = idle, 2 = very idle
      lastCheck: Date.now(),
      cpuHistory: []
    };
    this.rateLimitHistory = []; // Track recent rate limit detections
    this.pauseDebounceTime = 60000; // 1 minute debounce for pause detection
  }

  async loadConfig() {
    try {
      const configData = await fsPromises.readFile(CONFIG.configFile, 'utf-8');
      const config = JSON.parse(configData);
      
      // Check for monitor settings first, then fall back to general settings
      const settings = config.monitorSettings || config;
      
      // Override default intervals if configured
      if (settings.checkIntervalActive) {
        CONFIG.checkIntervalActive = settings.checkIntervalActive * 1000;
      } else if (config.logRefreshRate) {
        // Fall back to logRefreshRate for active interval
        CONFIG.checkIntervalActive = config.logRefreshRate * 1000;
      }
      
      if (settings.checkIntervalIdle) {
        CONFIG.checkIntervalIdle = settings.checkIntervalIdle * 1000;
      }
      if (settings.checkIntervalMaxIdle) {
        CONFIG.checkIntervalMaxIdle = settings.checkIntervalMaxIdle * 1000;
      }
      
      console.log(`📊 Loaded config with intervals: active=${CONFIG.checkIntervalActive/1000}s, idle=${CONFIG.checkIntervalIdle/1000}s, max-idle=${CONFIG.checkIntervalMaxIdle/1000}s`);
      
      return config;
    } catch (error) {
      console.log('📊 Using default intervals (config not found)');
      return {};
    }
  }

  async getCPUUsage() {
    try {
      const startMeasure = os.cpus();
      await new Promise(resolve => setTimeout(resolve, 100)); // Sample for 100ms
      const endMeasure = os.cpus();
      
      let totalIdle = 0;
      let totalTick = 0;
      
      for (let i = 0; i < startMeasure.length; i++) {
        for (let type in startMeasure[i].times) {
          totalTick += endMeasure[i].times[type] - startMeasure[i].times[type];
        }
        totalIdle += endMeasure[i].times.idle - startMeasure[i].times.idle;
      }
      
      const idlePercent = totalIdle / totalTick;
      const usagePercent = 1 - idlePercent;
      
      return usagePercent;
    } catch (error) {
      return 0.5; // Default to 50% if we can't measure
    }
  }

  async updateIdleState() {
    const now = Date.now();
    const timeSinceActivity = now - this.lastActivityTime;
    const minutesSinceActivity = timeSinceActivity / 60000;
    
    // Get CPU usage
    const cpuUsage = await this.getCPUUsage();
    this.idleState.cpuHistory.push(cpuUsage);
    if (this.idleState.cpuHistory.length > 10) {
      this.idleState.cpuHistory.shift(); // Keep last 10 samples
    }
    
    const avgCpuUsage = this.idleState.cpuHistory.reduce((a, b) => a + b, 0) / this.idleState.cpuHistory.length;
    
    // Determine idle level
    const previousIdleLevel = this.idleState.idleLevel;
    
    if (minutesSinceActivity < CONFIG.idleThresholdMinutes || avgCpuUsage > CONFIG.cpuIdleThreshold) {
      // Active
      this.idleState.isIdle = false;
      this.idleState.idleLevel = 0;
    } else if (minutesSinceActivity < CONFIG.idleThresholdMinutes * 3) {
      // Idle
      this.idleState.isIdle = true;
      this.idleState.idleLevel = 1;
    } else {
      // Very idle
      this.idleState.isIdle = true;
      this.idleState.idleLevel = 2;
    }
    
    this.idleState.lastCheck = now;
    
    // Adjust interval based on idle state
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
      
      if (previousIdleLevel !== this.idleState.idleLevel) {
        const stateNames = ['Active', 'Idle', 'Very Idle'];
        console.log(`🔄 Switched to ${stateNames[this.idleState.idleLevel]} mode (${this.checkInterval/1000}s interval, CPU: ${(avgCpuUsage * 100).toFixed(1)}%)`);
      }
    }
    
    // Save idle state
    try {
      await fsPromises.writeFile(CONFIG.idleStateFile, JSON.stringify(this.idleState, null, 2));
    } catch (error) {
      // Ignore save errors
    }
  }

  async start() {
    console.log('🚀 Starting Idle-Aware Claude Loop Monitor...\n');
    
    await fsPromises.mkdir(CONFIG.logDir, { recursive: true });
    
    // Load config and previous idle state
    await this.loadConfig();
    
    try {
      const savedState = await fsPromises.readFile(CONFIG.idleStateFile, 'utf-8');
      const parsed = JSON.parse(savedState);
      if (parsed.lastCheck && Date.now() - parsed.lastCheck < 300000) { // Within 5 minutes
        this.idleState = parsed;
        console.log(`📊 Restored idle state: ${this.idleState.isIdle ? 'Idle' : 'Active'} (level ${this.idleState.idleLevel})`);
      }
    } catch (error) {
      // No saved state or error reading it
    }
    
    this.isRunning = true;
    this.currentLogPath = this.getCurrentLogPath();
    this.lastRotationDate = new Date().toDateString();
    
    // Initialize or continue with existing log
    await this.initializeLog();
    
    // Start monitoring
    this.startMonitoring();
    
    console.log('✅ Monitor started with idle detection:');
    console.log('   - Active mode: 1s refresh');
    console.log('   - Idle mode: 5s refresh (after 2 min inactivity)');
    console.log('   - Very idle mode: 30s refresh (after 6 min inactivity)');
    console.log('   - CPU threshold: 10% for idle detection');
    console.log('   - Improved rate limit detection');
    console.log('   - Current log:', path.basename(this.currentLogPath));
    console.log('');
  }

  getCurrentLogPath() {
    // Write to ANSI_tmp directory for dashboard compatibility
    const ansiLogDir = path.join(CONFIG.logDir, 'ANSI_tmp');
    // Create directory if it doesn't exist
    fs.mkdirSync(ansiLogDir, { recursive: true });
    // Use session name without date for ANSI logs
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
        console.log(`📄 Created new log file for today`);
      }
    } catch (err) {
      console.error('Error initializing log:', err.message);
    }
  }

  hashContent(content) {
    // Simple hash for change detection
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) - hash) + content.charCodeAt(i);
      hash = hash & hash; // Convert to 32bit integer
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
      
      // Check if content changed
      if (currentHash !== this.lastContentHash) {
        this.lastActivityTime = Date.now();
        this.lastContentHash = currentHash;
        
        // Write the entire current content (simplified approach)
        await fsPromises.writeFile(this.currentLogPath, currentContent);
        
        const sizeMB = (currentContent.length / 1024 / 1024).toFixed(2);
        console.log(`📝 Updated log (${sizeMB}MB) - Activity detected`);
      }
    } catch (err) {
      console.error('Error syncing content:', err.message);
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
      await this.initializeLog();
    }
  }

  async rotateLog(reason) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const date = new Date().toISOString().split('T')[0];
      const rotatedName = `${CONFIG.sessionName}_${date}_${timestamp}_${reason}.log`;
      // Rotate to the main log directory, not ANSI_tmp
      const rotatedPath = path.join(CONFIG.logDir, rotatedName);
      
      await fsPromises.rename(this.currentLogPath, rotatedPath);
      console.log(`✅ Log rotated to: ${rotatedName}`);
      
      // Start fresh log with minimal content
      const recentContent = await this.captureCurrentTmuxContent();
      const recentLines = recentContent.split('\n');
      const startContent = recentLines.slice(-100).join('\n');
      
      await fsPromises.writeFile(this.currentLogPath, startContent);
      this.lastContentHash = this.hashContent(startContent);
      
      console.log(`📄 New log started with 100 lines of context`);
      
      // Clean up old logs
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
    try {
      const content = await this.captureCurrentTmuxContent();
      const recentLines = content.split('\n').slice(-100); // Check more lines
      
      // More specific patterns that require stronger evidence
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
      
      // Require at least 2 matches to reduce false positives
      if (matchCount >= 2 && lastMatch) {
        const now = Date.now();
        
        // Check if we recently triggered a pause (debounce)
        const recentPause = this.rateLimitHistory.find(p => now - p.timestamp < this.pauseDebounceTime);
        if (recentPause) {
          return false; // Skip to avoid rapid re-pausing
        }
        
        console.log('\n⚠️  Usage limit detected (confirmed by multiple matches)!');
        console.log(`   Message: "${lastMatch.line.trim()}"`);
        
        // Parse time and create pause signal
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
        
        // Signal pause
        await fsPromises.writeFile(CONFIG.resumeTimeFile, resumeTime.toISOString());
        await fsPromises.writeFile(CONFIG.pauseFile, '1');
        
        // Track this pause
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
      
      // Update idle state first
      await this.updateIdleState();
      
      // Append new content
      await this.appendNewContent();
      
      // Check for rotation needs
      await this.checkAndRotate();
      
      // Check for usage limits (less frequently when idle)
      if (this.idleState.idleLevel === 0 || Math.random() < 0.2) {
        await this.checkForUsageLimit();
      }
      
    }, this.checkInterval);
    
    console.log(`🔄 Monitoring started (current interval: ${this.checkInterval / 1000}s)`);
  }

  async stop() {
    console.log('\n🛑 Stopping monitor...');
    this.isRunning = false;
    
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
    }
    
    // Final save
    await this.appendNewContent();
    
    // Save final idle state
    await fsPromises.writeFile(CONFIG.idleStateFile, JSON.stringify(this.idleState, null, 2));
    
    console.log('✅ Monitor stopped');
    process.exit(0);
  }
}

// Main execution
const monitor = new IdleAwareClaudeMonitor();

process.on('SIGINT', () => monitor.stop());
process.on('SIGTERM', () => monitor.stop());

// Handle uncaught errors gracefully
process.on('uncaughtException', (err) => {
  console.error('Uncaught error:', err);
  monitor.stop();
});

monitor.start().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});