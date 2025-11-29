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
 * Improved Claude Loop Monitor with Smart Log Rotation
 * - Rotates logs daily at midnight or when size exceeds 1MB
 * - Maintains a single current log file that gets rotated
 * - Minimizes content overlap between logs
 * - Appends new content from tmux instead of full captures
 */

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { spawn, exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const CONFIG = {
  maxLogSize: 1 * 1024 * 1024, // 1MB - rotate when exceeded
  checkInterval: 1000, // Default check interval, will be overridden by config
  logDir: path.join(process.env.HOME, 'InfiniQuest', 'tmp', 'claudeLogs'),
  sessionName: 'claude',
  pauseFile: '/tmp/claude_loop_paused',
  resumeTimeFile: '/tmp/claude_loop_resume_time',
  configFile: path.join(__dirname, 'loop-config.json')
};

class ImprovedClaudeMonitor {
  constructor() {
    this.isRunning = false;
    this.lastLineCount = 0;
    this.currentLogPath = null;
    this.lastRotationDate = null;
    this.checkInterval = CONFIG.checkInterval;
    this.intervalHandle = null;
  }

  async loadConfig() {
    try {
      const configData = await fsPromises.readFile(CONFIG.configFile, 'utf-8');
      const config = JSON.parse(configData);
      
      // Use logRefreshRate from config if available
      if (config.logRefreshRate) {
        this.checkInterval = config.logRefreshRate * 1000; // Convert seconds to milliseconds
        console.log(`📊 Using log refresh rate from config: ${config.logRefreshRate} seconds`);
      }
      
      // Also respect maxLogSize if configured
      if (config.maxLogSize) {
        CONFIG.maxLogSize = config.maxLogSize;
      }
    } catch (error) {
      console.log('📊 Using default check interval (config not found or invalid)');
    }
  }

  async start() {
    console.log('🚀 Starting Improved Claude Loop Monitor...\n');
    
    await fsPromises.mkdir(CONFIG.logDir, { recursive: true });
    
    // Load config before starting
    await this.loadConfig();
    
    this.isRunning = true;
    this.currentLogPath = this.getCurrentLogPath();
    this.lastRotationDate = new Date().toDateString();
    
    // Initialize or continue with existing log
    await this.initializeLog();
    
    // Start monitoring
    this.startMonitoring();
    
    console.log('✅ Monitor started with improved features:');
    console.log('   - Daily rotation at midnight');
    console.log('   - Size-based rotation at 1MB');
    console.log('   - Incremental content appending');
    console.log('   - Usage limit detection');
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
        console.log(`📄 Created new log file for today`);
      }
    } catch (err) {
      console.error('Error initializing log:', err.message);
    }
  }

  async captureCurrentTmuxContent() {
    try {
      // Capture full scrollback buffer with ANSI escape codes preserved
      const { stdout } = await execPromise(
        `tmux capture-pane -ept "${CONFIG.sessionName}" -S -2000 2>/dev/null || echo ""`
      );
      
      // Return the raw content without filtering
      // The sync logic will handle keeping only the most recent UI elements
      return stdout;
    } catch (err) {
      return '';
    }
  }

  async appendNewContent() {
    try {
      // Get current tmux content (now includes UI elements)
      const currentContent = await this.captureCurrentTmuxContent();
      
      if (!currentContent) return;
      
      // Read existing log content
      let existingContent;
      try {
        existingContent = await fsPromises.readFile(this.currentLogPath, 'utf8');
      } catch (err) {
        // File doesn't exist yet, create it
        await fsPromises.writeFile(this.currentLogPath, currentContent);
        console.log(`📝 Created new log file`);
        return;
      }
      
      // If filtered console content is exactly the same as log, do nothing
      if (existingContent === currentContent) {
        return;
      }
      
      // Split into lines for easier comparison
      const existingLines = existingContent.split('\n');
      const currentLines = currentContent.split('\n');
      
      // Find where they diverge by comparing lines
      let lastMatchingLine = -1;
      const searchWindow = Math.min(existingLines.length, currentLines.length);
      
      for (let i = 0; i < searchWindow; i++) {
        if (existingLines[i] === currentLines[i]) {
          lastMatchingLine = i;
        } else {
          break;
        }
      }
      
      // If we have new or different content
      if (lastMatchingLine < currentLines.length - 1) {
        if (lastMatchingLine === -1) {
          // No matching lines - complete replacement
          await fsPromises.writeFile(this.currentLogPath, currentContent);
          console.log(`📝 Replaced entire log with filtered console content`);
        } else {
          // Keep matching lines and append new content
          const keepLines = existingLines.slice(0, lastMatchingLine + 1);
          const newLines = currentLines.slice(lastMatchingLine + 1);
          
          const updatedContent = [...keepLines, ...newLines].join('\n');
          await fsPromises.writeFile(this.currentLogPath, updatedContent);
          
          console.log(`📝 Updated log: kept ${keepLines.length} lines, added ${newLines.length} new lines`);
        }
      } else if (existingLines.length > currentLines.length) {
        // Log has extra content that console doesn't - trim it
        await fsPromises.writeFile(this.currentLogPath, currentContent);
        console.log(`📝 Trimmed log to match console content`);
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
      
      // Move current log to rotated name
      await fsPromises.rename(this.currentLogPath, rotatedPath);
      
      console.log(`✅ Log rotated to: ${rotatedName}`);
      
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
    this.intervalHandle = setInterval(async () => {
      if (!this.isRunning) return;
      
      // Append new content
      await this.appendNewContent();
      
      // Check for rotation needs
      await this.checkAndRotate();
      
      // Check for usage limits
      await this.checkForUsageLimit();
      
    }, this.checkInterval);
    
    console.log(`🔄 Monitoring started with ${this.checkInterval / 1000} second interval`);
  }

  async reloadConfig() {
    const oldInterval = this.checkInterval;
    await this.loadConfig();
    
    // If interval changed, restart monitoring
    if (oldInterval !== this.checkInterval && this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.startMonitoring();
      console.log(`🔄 Restarted monitoring with new interval: ${this.checkInterval / 1000} seconds`);
    }
  }

  async stop() {
    console.log('\n🛑 Stopping monitor...');
    this.isRunning = false;
    
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
    }
    
    // Final save
    await this.appendNewContent();
    
    console.log('✅ Monitor stopped');
    process.exit(0);
  }
}

// Main execution
const monitor = new ImprovedClaudeMonitor();

process.on('SIGINT', () => monitor.stop());
process.on('SIGTERM', () => monitor.stop());

monitor.start().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});