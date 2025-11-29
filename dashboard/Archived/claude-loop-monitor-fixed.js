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
 */

/**
 * Fixed Claude Loop Monitor with Improved Usage Detection
 * 
 * Fixes applied:
 * - Adds cooldown period after detecting reset message
 * - Ignores reset times >12 hours away (assumes they're from yesterday)
 * - Tracks when usage limit was last detected to avoid double detection
 * - Adds context monitoring for low context warnings
 */

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { spawn, exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const CONFIG = {
  maxLogSize: 1 * 1024 * 1024, // 1MB - rotate when exceeded
  checkInterval: 30000, // Check every 30 seconds
  logDir: path.join(process.env.HOME, 'InfiniQuest', 'tmp', 'claudeLogs'),
  sessionName: 'claude',
  pauseFile: '/tmp/claude_loop_paused',
  resumeTimeFile: '/tmp/claude_loop_resume_time',
  // New config options for bug fixes
  usageLimitCooldown: 30 * 60 * 1000, // 30 minutes cooldown after detecting usage limit
  maxResumeTimeHours: 12, // Ignore resume times more than 12 hours away
  contextWarningThreshold: 20, // Warn when context below 20%
  stateFile: '/tmp/claude_loop_state.json'
};

class FixedClaudeMonitor {
  constructor() {
    this.isRunning = false;
    this.lastLineCount = 0;
    this.currentLogPath = null;
    this.lastRotationDate = null;
    // New state tracking
    this.lastUsageLimitDetected = null;
    this.lastContextPercentage = 100;
    this.state = {
      lastUsageLimitDetected: null,
      resumeTime: null,
      isPaused: false
    };
  }

  async loadState() {
    try {
      if (fs.existsSync(CONFIG.stateFile)) {
        const stateData = await fsPromises.readFile(CONFIG.stateFile, 'utf8');
        this.state = JSON.parse(stateData);
        if (this.state.lastUsageLimitDetected) {
          this.state.lastUsageLimitDetected = new Date(this.state.lastUsageLimitDetected);
        }
        if (this.state.resumeTime) {
          this.state.resumeTime = new Date(this.state.resumeTime);
        }
      }
    } catch (err) {
      console.error('Error loading state:', err.message);
    }
  }

  async saveState() {
    try {
      await fsPromises.writeFile(CONFIG.stateFile, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.error('Error saving state:', err.message);
    }
  }

  async start() {
    console.log('🚀 Starting Fixed Claude Loop Monitor...\n');
    
    await fsPromises.mkdir(CONFIG.logDir, { recursive: true });
    await this.loadState();
    
    this.isRunning = true;
    this.currentLogPath = this.getCurrentLogPath();
    this.lastRotationDate = new Date().toDateString();
    
    // Initialize or continue with existing log
    await this.initializeLog();
    
    // Start monitoring
    this.startMonitoring();
    
    console.log('✅ Monitor started with fixes and improvements:');
    console.log('   - Usage limit cooldown period (30 min)');
    console.log('   - Ignores reset times >12 hours away');
    console.log('   - Context monitoring and warnings');
    console.log('   - State persistence across restarts');
    console.log('   - Current log:', path.basename(this.currentLogPath));
    console.log('');
  }

  getCurrentLogPath() {
    const date = new Date().toISOString().split('T')[0];
    return path.join(CONFIG.logDir, `claude_${date}_current.txt`);
  }

  async initializeLog() {
    try {
      // Check if current log exists
      const exists = fs.existsSync(this.currentLogPath);
      if (exists) {
        // Count existing lines to continue from where we left off
        const content = await fsPromises.readFile(this.currentLogPath, 'utf8');
        this.lastLineCount = content.split('\n').length;
        console.log(`📄 Continuing existing log with ${this.lastLineCount} lines`);
      } else {
        // Create new log with initial content
        const initialContent = await this.captureCurrentTmuxContent();
        await fsPromises.writeFile(this.currentLogPath, initialContent);
        this.lastLineCount = initialContent.split('\n').length;
        console.log(`📄 Started new log with ${this.lastLineCount} lines`);
      }
    } catch (err) {
      console.error('Error initializing log:', err.message);
    }
  }

  async captureCurrentTmuxContent() {
    try {
      const { stdout } = await execPromise(`tmux capture-pane -t ${CONFIG.sessionName} -p -S -`);
      return stdout;
    } catch (err) {
      console.error('Error capturing tmux content:', err.message);
      return '';
    }
  }

  async appendNewContent() {
    try {
      const content = await this.captureCurrentTmuxContent();
      const lines = content.split('\n');
      
      if (lines.length > this.lastLineCount) {
        const newLines = lines.slice(this.lastLineCount);
        const newContent = '\n' + newLines.join('\n');
        
        await fsPromises.appendFile(this.currentLogPath, newContent);
        this.lastLineCount = lines.length;
        
        console.log(`✍️  Appended ${newLines.length} new lines`);
      }
    } catch (err) {
      console.error('Error appending content:', err.message);
    }
  }

  async checkAndRotate() {
    const now = new Date();
    const currentDate = now.toDateString();
    
    // Check for daily rotation
    const shouldRotateDaily = currentDate !== this.lastRotationDate;
    
    // Check for size-based rotation
    let shouldRotateSize = false;
    try {
      const stats = await fsPromises.stat(this.currentLogPath);
      shouldRotateSize = stats.size > CONFIG.maxLogSize;
    } catch (err) {
      // File doesn't exist yet
    }
    
    if (shouldRotateDaily || shouldRotateSize) {
      await this.rotateLog(shouldRotateDaily ? 'daily' : 'size');
      this.lastRotationDate = currentDate;
    }
  }

  async rotateLog(reason) {
    try {
      console.log(`\n🔄 Rotating log (${reason})...`);
      
      // Rename current log
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rotatedPath = this.currentLogPath.replace('_current.txt', `_${timestamp}.txt`);
      await fsPromises.rename(this.currentLogPath, rotatedPath);
      
      // Start fresh log with minimal content
      const recentContent = await this.captureCurrentTmuxContent();
      const recentLines = recentContent.split('\n');
      const startContent = recentLines.slice(-100).join('\n'); // Keep last 100 lines
      
      await fsPromises.writeFile(this.currentLogPath, startContent);
      this.lastLineCount = 100;
      
      console.log(`📄 New log started with ${this.lastLineCount} lines of context`);
      
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
      // Check cooldown period
      if (this.state.lastUsageLimitDetected) {
        const timeSinceLastDetection = Date.now() - this.state.lastUsageLimitDetected.getTime();
        if (timeSinceLastDetection < CONFIG.usageLimitCooldown) {
          // Still in cooldown, skip check
          return false;
        }
      }

      const content = await this.captureCurrentTmuxContent();
      const recentLines = content.split('\n').slice(-50);
      
      const limitPatterns = [
        /usage limit reached.*?(\d{1,2}):?(\d{0,2})\s*(am|pm)/i,
        /limit will reset at.*?(\d{1,2}):?(\d{0,2})\s*(am|pm)/i,
        /try again at.*?(\d{1,2}):?(\d{0,2})\s*(am|pm)/i
      ];
      
      for (const line of recentLines) {
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
            
            // Calculate hours until resume time
            const hoursUntilResume = (resumeTime.getTime() - Date.now()) / (1000 * 60 * 60);
            
            // If resume time is in the past or more than 12 hours away,
            // it's likely from yesterday
            if (hoursUntilResume < 0 || hoursUntilResume > CONFIG.maxResumeTimeHours) {
              console.log(`   Ignoring old reset time (${hoursUntilResume.toFixed(1)} hours away)`);
              // Update last detected time but don't pause
              this.state.lastUsageLimitDetected = new Date();
              await this.saveState();
              return false;
            }
            
            // Valid resume time - signal pause
            this.state.lastUsageLimitDetected = new Date();
            this.state.resumeTime = resumeTime;
            this.state.isPaused = true;
            await this.saveState();
            
            await fsPromises.writeFile(CONFIG.resumeTimeFile, resumeTime.toISOString());
            await fsPromises.writeFile(CONFIG.pauseFile, '1');
            
            console.log(`   Will resume at: ${resumeTime.toLocaleTimeString()}`);
            console.log(`   (In ${hoursUntilResume.toFixed(1)} hours)`);
            return true;
          }
        }
      }
    } catch (err) {
      console.error('Error checking usage limit:', err.message);
    }
    return false;
  }

  async checkContextLevel() {
    try {
      const content = await this.captureCurrentTmuxContent();
      const recentLines = content.split('\n').slice(-20);
      
      // Look for context percentage in output
      const contextPattern = /context.*?(\d+)%/i;
      
      for (const line of recentLines) {
        const match = line.match(contextPattern);
        if (match) {
          const percentage = parseInt(match[1]);
          
          if (percentage !== this.lastContextPercentage) {
            this.lastContextPercentage = percentage;
            
            if (percentage <= CONFIG.contextWarningThreshold) {
              console.log(`\n⚠️  Low context warning: ${percentage}% remaining`);
              
              // Create a summary file for the user
              const summaryPath = path.join(CONFIG.logDir, 'low_context_summary.md');
              const summaryContent = `# Low Context Warning
Date: ${new Date().toISOString()}
Context Remaining: ${percentage}%

## Action Required
The Claude loop is running low on context. Consider:
1. Requesting a compact operation
2. Saving important state/findings
3. Creating a session summary

## Recent Activity
Check the latest log file for recent activity:
${this.currentLogPath}
`;
              await fsPromises.writeFile(summaryPath, summaryContent);
              console.log(`   Summary saved to: ${summaryPath}`);
            }
          }
        }
      }
    } catch (err) {
      // Ignore errors in context checking
    }
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
      
      // Check context level
      await this.checkContextLevel();
      
    }, CONFIG.checkInterval);
  }

  async stop() {
    console.log('\n🛑 Stopping monitor...');
    this.isRunning = false;
    
    // Final save
    await this.appendNewContent();
    await this.saveState();
    
    console.log('✅ Monitor stopped');
    process.exit(0);
  }
}

// Start the monitor
const monitor = new FixedClaudeMonitor();

// Handle graceful shutdown
process.on('SIGINT', () => monitor.stop());
process.on('SIGTERM', () => monitor.stop());

// Start monitoring
monitor.start().catch(err => {
  console.error('Failed to start monitor:', err);
  process.exit(1);
});