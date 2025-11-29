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


const path = require('path');
const fs = require('fs').promises;
const { execSync } = require('child_process');

// Run from backend directory to access express
process.chdir(path.join(__dirname, '../backend'));

const express = require('express');

// Configuration
const CONFIG = {
  port: 3333,
  logDir: path.join(__dirname, '../tmp/claudeLogs'),
  sessionDir: path.join(__dirname, '../tmp/session_summaries'),
  maxLogLines: 100,
  refreshInterval: 5000, // 5 seconds
};

const app = express();

// Serve static files
app.use(express.static(path.join(__dirname)));

// Get current loop status
async function getLoopStatus() {
  try {
    // Check if claude loop process is running
    const processes = execSync('ps aux | grep -E "claude-loop|claude loop" | grep -v grep', { encoding: 'utf-8' })
      .trim()
      .split('\n')
      .filter(line => line.length > 0);
    
    // Get current log file
    const currentLogPath = path.join(CONFIG.logDir, `claude_${new Date().toISOString().split('T')[0]}_current.txt`);
    
    let currentLogSize = 0;
    let lastModified = null;
    
    try {
      const stats = await fs.stat(currentLogPath);
      currentLogSize = stats.size;
      lastModified = stats.mtime;
    } catch (error) {
      // Log file doesn't exist yet
    }
    
    return {
      isRunning: processes.length > 0,
      processCount: processes.length,
      currentLog: currentLogPath,
      logSize: currentLogSize,
      lastModified,
      processes: processes.map(p => {
        const parts = p.split(/\s+/);
        return {
          pid: parts[1],
          cpu: parts[2],
          mem: parts[3],
          command: parts.slice(10).join(' ')
        };
      })
    };
  } catch (error) {
    return {
      isRunning: false,
      processCount: 0,
      error: error.message
    };
  }
}

// Get log files
async function getLogFiles() {
  try {
    const files = await fs.readdir(CONFIG.logDir);
    const logFiles = files
      .filter(f => f.includes('claude') && f.endsWith('.txt'))
      .sort((a, b) => b.localeCompare(a));
    
    const fileStats = await Promise.all(
      logFiles.map(async (file) => {
        const filePath = path.join(CONFIG.logDir, file);
        const stats = await fs.stat(filePath);
        return {
          name: file,
          size: stats.size,
          modified: stats.mtime,
          path: filePath
        };
      })
    );
    
    return fileStats;
  } catch (error) {
    return [];
  }
}

// Get session summaries
async function getSessionSummaries() {
  try {
    const files = await fs.readdir(CONFIG.sessionDir);
    const summaries = files
      .filter(f => f.endsWith('.md'))
      .sort((a, b) => b.localeCompare(a));
    
    return summaries;
  } catch (error) {
    return [];
  }
}

// Get log tail
async function getLogTail(logPath, lines = CONFIG.maxLogLines) {
  try {
    const content = await fs.readFile(logPath, 'utf-8');
    const allLines = content.split('\n');
    const tailLines = allLines.slice(-lines);
    return tailLines.join('\n');
  } catch (error) {
    return `Error reading log: ${error.message}`;
  }
}

// API Routes
app.get('/api/status', async (req, res) => {
  const status = await getLoopStatus();
  const logs = await getLogFiles();
  const summaries = await getSessionSummaries();
  
  res.json({
    status,
    logs: logs.slice(0, 10), // Last 10 logs
    summaries: summaries.slice(0, 10), // Last 10 summaries
    timestamp: new Date().toISOString()
  });
});

app.get('/api/log/:filename', async (req, res) => {
  const filePath = path.join(CONFIG.logDir, req.params.filename);
  
  // Security check
  if (!filePath.startsWith(CONFIG.logDir)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  
  const tail = await getLogTail(filePath);
  res.json({ content: tail });
});

app.get('/api/summary/:filename', async (req, res) => {
  const filePath = path.join(CONFIG.sessionDir, req.params.filename);
  
  // Security check
  if (!filePath.startsWith(CONFIG.sessionDir)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    res.json({ content });
  } catch (error) {
    res.status(404).json({ error: 'Summary not found' });
  }
});

// Main dashboard page
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Claude Loop Monitor Dashboard</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      margin: 0;
      padding: 20px;
      background: #f5f5f5;
      color: #333;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    h1 {
      color: #2c3e50;
      margin-bottom: 30px;
    }
    .status-card {
      background: white;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 20px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .status-indicator {
      display: inline-block;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      margin-right: 8px;
    }
    .status-running { background: #4CAF50; }
    .status-stopped { background: #f44336; }
    .metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
      margin: 20px 0;
    }
    .metric {
      background: #f8f9fa;
      padding: 15px;
      border-radius: 4px;
    }
    .metric-label {
      font-size: 12px;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .metric-value {
      font-size: 24px;
      font-weight: bold;
      margin-top: 5px;
    }
    .log-viewer {
      background: #1e1e1e;
      color: #d4d4d4;
      padding: 15px;
      border-radius: 4px;
      font-family: 'Consolas', 'Monaco', monospace;
      font-size: 12px;
      line-height: 1.5;
      overflow-x: auto;
      max-height: 400px;
      overflow-y: auto;
    }
    .file-list {
      list-style: none;
      padding: 0;
    }
    .file-item {
      padding: 10px;
      background: #f8f9fa;
      margin-bottom: 8px;
      border-radius: 4px;
      cursor: pointer;
      transition: background 0.2s;
    }
    .file-item:hover {
      background: #e9ecef;
    }
    .file-size {
      float: right;
      color: #666;
      font-size: 12px;
    }
    .tabs {
      display: flex;
      gap: 10px;
      margin-bottom: 20px;
      border-bottom: 2px solid #e0e0e0;
    }
    .tab {
      padding: 10px 20px;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: all 0.2s;
    }
    .tab.active {
      color: #2196F3;
      border-bottom-color: #2196F3;
    }
    .tab-content {
      display: none;
    }
    .tab-content.active {
      display: block;
    }
    .refresh-info {
      text-align: right;
      color: #666;
      font-size: 12px;
      margin-top: 10px;
    }
    .process-list {
      margin-top: 10px;
      font-size: 12px;
    }
    .process-item {
      background: #f0f0f0;
      padding: 8px;
      margin-bottom: 4px;
      border-radius: 4px;
      font-family: monospace;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🤖 Claude Loop Monitor</h1>
    
    <div class="status-card">
      <h2>
        <span id="status-indicator" class="status-indicator"></span>
        <span id="status-text">Checking status...</span>
      </h2>
      
      <div class="metrics">
        <div class="metric">
          <div class="metric-label">Processes Running</div>
          <div class="metric-value" id="process-count">-</div>
        </div>
        <div class="metric">
          <div class="metric-label">Current Log Size</div>
          <div class="metric-value" id="log-size">-</div>
        </div>
        <div class="metric">
          <div class="metric-label">Last Activity</div>
          <div class="metric-value" id="last-activity">-</div>
        </div>
      </div>
      
      <div id="process-list" class="process-list"></div>
    </div>
    
    <div class="tabs">
      <div class="tab active" onclick="showTab('logs')">📄 Logs</div>
      <div class="tab" onclick="showTab('summaries')">📝 Session Summaries</div>
      <div class="tab" onclick="showTab('current')">🔴 Current Log</div>
    </div>
    
    <div id="logs-tab" class="tab-content active">
      <h3>Recent Log Files</h3>
      <ul id="log-list" class="file-list"></ul>
    </div>
    
    <div id="summaries-tab" class="tab-content">
      <h3>Session Summaries</h3>
      <ul id="summary-list" class="file-list"></ul>
    </div>
    
    <div id="current-tab" class="tab-content">
      <h3>Current Log Output</h3>
      <pre id="current-log" class="log-viewer">Loading...</pre>
    </div>
    
    <div class="refresh-info">
      Auto-refreshing every 5 seconds | Last update: <span id="last-update">-</span>
    </div>
  </div>

  <script>
    let currentTab = 'logs';
    let currentLogFile = null;
    
    function formatBytes(bytes) {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }
    
    function formatTime(date) {
      if (!date) return 'Never';
      const d = new Date(date);
      const now = new Date();
      const diff = now - d;
      
      if (diff < 60000) return 'Just now';
      if (diff < 3600000) return Math.floor(diff / 60000) + ' min ago';
      if (diff < 86400000) return Math.floor(diff / 3600000) + ' hours ago';
      
      return d.toLocaleString();
    }
    
    function showTab(tab) {
      currentTab = tab;
      
      // Update tab UI
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      
      event.target.classList.add('active');
      document.getElementById(tab + '-tab').classList.add('active');
    }
    
    async function loadLog(filename) {
      try {
        const response = await fetch('/api/log/' + filename);
        const data = await response.json();
        document.getElementById('current-log').textContent = data.content;
        currentLogFile = filename;
      } catch (error) {
        console.error('Error loading log:', error);
      }
    }
    
    async function loadSummary(filename) {
      try {
        const response = await fetch('/api/summary/' + filename);
        const data = await response.json();
        document.getElementById('current-log').textContent = data.content;
        
        // Switch to current tab
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.querySelectorAll('.tab')[2].classList.add('active');
        document.getElementById('current-tab').classList.add('active');
      } catch (error) {
        console.error('Error loading summary:', error);
      }
    }
    
    async function updateDashboard() {
      try {
        const response = await fetch('/api/status');
        const data = await response.json();
        
        // Update status
        const statusIndicator = document.getElementById('status-indicator');
        const statusText = document.getElementById('status-text');
        
        if (data.status.isRunning) {
          statusIndicator.className = 'status-indicator status-running';
          statusText.textContent = 'Claude Loop is Running';
        } else {
          statusIndicator.className = 'status-indicator status-stopped';
          statusText.textContent = 'Claude Loop is Stopped';
        }
        
        // Update metrics
        document.getElementById('process-count').textContent = data.status.processCount;
        document.getElementById('log-size').textContent = formatBytes(data.status.logSize);
        document.getElementById('last-activity').textContent = formatTime(data.status.lastModified);
        
        // Update process list
        const processList = document.getElementById('process-list');
        if (data.status.processes && data.status.processes.length > 0) {
          processList.innerHTML = '<h4>Running Processes:</h4>' + 
            data.status.processes.map(p => 
              '<div class="process-item">PID: ' + p.pid + ' | CPU: ' + p.cpu + '% | MEM: ' + p.mem + '% | ' + p.command + '</div>'
            ).join('');
        } else {
          processList.innerHTML = '';
        }
        
        // Update log list
        const logList = document.getElementById('log-list');
        logList.innerHTML = data.logs.map(log => 
          '<li class="file-item" onclick="loadLog(\'' + log.name + '\')">' + 
            log.name + 
            '<span class="file-size">' + formatBytes(log.size) + '</span>' +
          '</li>'
        ).join('');
        
        // Update summary list
        const summaryList = document.getElementById('summary-list');
        summaryList.innerHTML = data.summaries.map(summary => 
          '<li class="file-item" onclick="loadSummary(\'' + summary + '\')">' + 
            summary + 
          '</li>'
        ).join('');
        
        // Update current log if viewing
        if (currentTab === 'current' && data.status.currentLog) {
          if (!currentLogFile) {
            currentLogFile = data.status.currentLog.split('/').pop();
          }
          loadLog(currentLogFile);
        }
        
        // Update last update time
        document.getElementById('last-update').textContent = new Date().toLocaleTimeString();
        
      } catch (error) {
        console.error('Error updating dashboard:', error);
      }
    }
    
    // Initial load and set interval
    updateDashboard();
    setInterval(updateDashboard, 5000);
  </script>
</body>
</html>
  `);
});

// Start server
app.listen(CONFIG.port, () => {
  console.log(`
🌐 Claude Loop Dashboard Started!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📍 Dashboard URL: http://localhost:${CONFIG.port}

Features:
  • Real-time loop status monitoring
  • Process tracking with CPU/Memory usage
  • Log file viewer with tail functionality
  • Session summary browser
  • Auto-refresh every 5 seconds

Press Ctrl+C to stop the dashboard.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `);
});