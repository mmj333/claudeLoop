#!/usr/bin/env node

/*
 * InfiniQuest - Family Productivity Software
 * Copyright (C) 2025 Michael Johnson <wholeness@infiniquest.app>
 *
 * Enhanced Claude Loop Dashboard with Context Control
 */

const http = require('http');
const fs = require('fs').promises;
const path = require('path');
const { exec, spawn } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

// Configuration
const CONFIG = {
  port: process.env.PORT || 3334,  // Different port from simple dashboard
  logDir: path.join(__dirname, '../../claudeLogs'),
  sessionDir: path.join(__dirname, '../../session_summaries'),
  contextStateFile: '/tmp/claude_context_state.json',
  pauseFile: '/tmp/claude_loop_paused',
  customMessageFile: '/tmp/claude_custom_message.txt',
  maxLogLines: 100,
};

// API endpoints
async function handleAPI(pathname, method, body, res) {
  try {
    switch (pathname) {
      case '/api/status':
        const status = await getLoopStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
        break;

      case '/api/logs':
        const logs = await getRecentLogs();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ logs }));
        break;

      case '/api/context':
        const context = await getContextStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(context));
        break;

      case '/api/pause':
        if (method === 'POST') {
          await fs.writeFile(CONFIG.pauseFile, new Date().toISOString());
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        }
        break;

      case '/api/resume':
        if (method === 'POST') {
          try {
            await fs.unlink(CONFIG.pauseFile);
          } catch (e) {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        }
        break;

      case '/api/message':
        if (method === 'POST') {
          const data = JSON.parse(body);
          await fs.writeFile(CONFIG.customMessageFile, data.message);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } else {
          let message = '';
          try {
            message = await fs.readFile(CONFIG.customMessageFile, 'utf-8');
          } catch (e) {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message }));
        }
        break;

      case '/api/start-loop':
        if (method === 'POST') {
          const data = JSON.parse(body);
          const script = data.contextAware 
            ? 'claude-loop-context-aware.sh'
            : 'claude-loop-enhanced-v2.sh';
          
          exec(`cd ${path.join(__dirname, '..')} && nohup ./${script} "${data.message || ''}" > /tmp/claude-loop.log 2>&1 &`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        }
        break;

      case '/api/stop-loop':
        if (method === 'POST') {
          await execAsync('pkill -f "claude-loop.*\\.sh"');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        }
        break;

      default:
        res.writeHead(404);
        res.end('Not found');
    }
  } catch (error) {
    console.error('API error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

async function getLoopStatus() {
  try {
    let processes = [];
    try {
      const { stdout } = await execAsync('ps aux | grep -E "claude-loop.*\\.sh" | grep -v grep');
      processes = stdout.trim().split('\n').filter(line => line.length > 0);
    } catch (e) {}
    
    const isPaused = await fs.access(CONFIG.pauseFile).then(() => true).catch(() => false);
    
    return {
      running: processes.length > 0,
      paused: isPaused,
      processes: processes.map(p => {
        const parts = p.split(/\s+/);
        return {
          pid: parts[1],
          script: parts.slice(10).join(' ')
        };
      })
    };
  } catch (error) {
    return { running: false, paused: false, error: error.message };
  }
}

async function getContextStatus() {
  try {
    const data = await fs.readFile(CONFIG.contextStateFile, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    return { contextPercent: 100, timestamp: new Date().toISOString() };
  }
}

async function getRecentLogs() {
  try {
    const currentLogPath = path.join(CONFIG.logDir, `claude_${new Date().toISOString().split('T')[0]}_current.txt`);
    const content = await fs.readFile(currentLogPath, 'utf-8');
    const lines = content.split('\n');
    return lines.slice(-CONFIG.maxLogLines).join('\n');
  } catch (e) {
    return '';
  }
}

// Enhanced dashboard HTML
const dashboardHTML = `
<!DOCTYPE html>
<html>
<head>
  <title>Claude Loop Control Center</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      margin: 0;
      padding: 20px;
      background: #1a1a1a;
      color: #e0e0e0;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
    }
    h1 {
      color: #4fc3f7;
      margin-bottom: 30px;
      display: flex;
      align-items: center;
      gap: 15px;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 2fr;
      gap: 20px;
      margin-bottom: 20px;
    }
    .card {
      background: #2a2a2a;
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.3);
    }
    .control-panel {
      display: flex;
      flex-direction: column;
      gap: 15px;
    }
    .status {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 15px;
      background: #333;
      border-radius: 8px;
    }
    .status-indicator {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0% { opacity: 1; }
      50% { opacity: 0.5; }
      100% { opacity: 1; }
    }
    .running { background: #4CAF50; }
    .paused { background: #ff9800; }
    .stopped { background: #f44336; }
    
    .context-meter {
      margin: 20px 0;
    }
    .context-bar {
      height: 30px;
      background: #333;
      border-radius: 15px;
      overflow: hidden;
      position: relative;
    }
    .context-fill {
      height: 100%;
      background: linear-gradient(90deg, #4CAF50, #8BC34A);
      transition: width 0.3s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #000;
      font-weight: bold;
    }
    .context-warning {
      background: linear-gradient(90deg, #ff9800, #ffb74d);
    }
    .context-critical {
      background: linear-gradient(90deg, #f44336, #ef5350);
    }
    
    .button {
      padding: 12px 24px;
      border: none;
      border-radius: 6px;
      font-size: 16px;
      cursor: pointer;
      transition: all 0.3s;
      text-align: center;
    }
    .button:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 8px rgba(0,0,0,0.3);
    }
    .button-primary {
      background: #4fc3f7;
      color: #000;
    }
    .button-danger {
      background: #f44336;
      color: white;
    }
    .button-success {
      background: #4CAF50;
      color: white;
    }
    .button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
    }
    
    .message-input {
      width: 100%;
      padding: 15px;
      background: #333;
      border: 1px solid #555;
      border-radius: 8px;
      color: #e0e0e0;
      font-family: 'Monaco', 'Consolas', monospace;
      font-size: 14px;
      resize: vertical;
      min-height: 100px;
    }
    
    .log-viewer {
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 8px;
      padding: 15px;
      height: 400px;
      overflow-y: auto;
      font-family: 'Monaco', 'Consolas', monospace;
      font-size: 13px;
      line-height: 1.5;
    }
    
    .options {
      display: flex;
      gap: 15px;
      align-items: center;
    }
    
    .checkbox-label {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
    }
    
    .info-text {
      color: #888;
      font-size: 14px;
      margin-top: 5px;
    }
    
    @media (max-width: 768px) {
      .grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🤖 Claude Loop Control Center</h1>
    
    <div class="grid">
      <div class="card control-panel">
        <h2>Status</h2>
        <div class="status" id="status">
          <div class="status-indicator stopped"></div>
          <span>Checking...</span>
        </div>
        
        <h3>Context Usage</h3>
        <div class="context-meter">
          <div class="context-bar">
            <div class="context-fill" id="context-fill" style="width: 100%">
              100%
            </div>
          </div>
          <div class="info-text" id="context-info">Last updated: Never</div>
        </div>
        
        <h3>Loop Control</h3>
        <div class="options">
          <label class="checkbox-label">
            <input type="checkbox" id="context-aware" checked>
            <span>Context-Aware Mode</span>
          </label>
        </div>
        
        <textarea 
          id="custom-message" 
          class="message-input" 
          placeholder="Enter custom message for Claude (optional)..."
        ></textarea>
        
        <div style="display: flex; gap: 10px;">
          <button id="start-btn" class="button button-success" onclick="startLoop()">
            Start Loop
          </button>
          <button id="stop-btn" class="button button-danger" onclick="stopLoop()">
            Stop Loop
          </button>
        </div>
        
        <div style="display: flex; gap: 10px;">
          <button id="pause-btn" class="button button-primary" onclick="pauseLoop()">
            Pause
          </button>
          <button id="resume-btn" class="button button-primary" onclick="resumeLoop()">
            Resume
          </button>
        </div>
      </div>
      
      <div class="card">
        <h2>Live Logs</h2>
        <div class="log-viewer" id="logs">
          Loading logs...
        </div>
      </div>
    </div>
  </div>
  
  <script>
    let statusInterval;
    let logInterval;
    
    async function updateStatus() {
      try {
        const response = await fetch('/api/status');
        const status = await response.json();
        
        const statusEl = document.getElementById('status');
        const indicator = statusEl.querySelector('.status-indicator');
        const text = statusEl.querySelector('span');
        
        if (status.running) {
          if (status.paused) {
            indicator.className = 'status-indicator paused';
            text.textContent = 'Paused';
          } else {
            indicator.className = 'status-indicator running';
            text.textContent = 'Running';
          }
        } else {
          indicator.className = 'status-indicator stopped';
          text.textContent = 'Stopped';
        }
        
        // Update buttons
        document.getElementById('start-btn').disabled = status.running;
        document.getElementById('stop-btn').disabled = !status.running;
        document.getElementById('pause-btn').disabled = !status.running || status.paused;
        document.getElementById('resume-btn').disabled = !status.running || !status.paused;
        
      } catch (error) {
        console.error('Failed to update status:', error);
      }
    }
    
    async function updateContext() {
      try {
        const response = await fetch('/api/context');
        const context = await response.json();
        
        const fill = document.getElementById('context-fill');
        const info = document.getElementById('context-info');
        
        const percent = context.contextPercent || 100;
        fill.style.width = percent + '%';
        fill.textContent = percent + '%';
        
        // Update color based on percentage
        fill.className = 'context-fill';
        if (percent <= 10) {
          fill.classList.add('context-critical');
        } else if (percent <= 20) {
          fill.classList.add('context-warning');
        }
        
        if (context.timestamp) {
          const date = new Date(context.timestamp);
          info.textContent = 'Last updated: ' + date.toLocaleTimeString();
        }
      } catch (error) {
        console.error('Failed to update context:', error);
      }
    }
    
    async function updateLogs() {
      try {
        const response = await fetch('/api/logs');
        const data = await response.json();
        
        const logsEl = document.getElementById('logs');
        logsEl.textContent = data.logs || 'No logs available';
        logsEl.scrollTop = logsEl.scrollHeight;
      } catch (error) {
        console.error('Failed to update logs:', error);
      }
    }
    
    async function startLoop() {
      const message = document.getElementById('custom-message').value;
      const contextAware = document.getElementById('context-aware').checked;
      
      await fetch('/api/start-loop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, contextAware })
      });
      
      setTimeout(updateStatus, 1000);
    }
    
    async function stopLoop() {
      await fetch('/api/stop-loop', { method: 'POST' });
      setTimeout(updateStatus, 1000);
    }
    
    async function pauseLoop() {
      await fetch('/api/pause', { method: 'POST' });
      setTimeout(updateStatus, 500);
    }
    
    async function resumeLoop() {
      await fetch('/api/resume', { method: 'POST' });
      setTimeout(updateStatus, 500);
    }
    
    // Load saved message
    async function loadMessage() {
      try {
        const response = await fetch('/api/message');
        const data = await response.json();
        if (data.message) {
          document.getElementById('custom-message').value = data.message;
        }
      } catch (error) {}
    }
    
    // Save message on change
    document.getElementById('custom-message').addEventListener('change', async (e) => {
      await fetch('/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: e.target.value })
      });
    });
    
    // Initialize
    loadMessage();
    updateStatus();
    updateContext();
    updateLogs();
    
    // Set up auto-refresh
    statusInterval = setInterval(() => {
      updateStatus();
      updateContext();
    }, 5000);
    
    logInterval = setInterval(updateLogs, 10000);
  </script>
</body>
</html>
`;

// HTTP Server
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  
  // Handle API requests
  if (pathname.startsWith('/api/')) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => handleAPI(pathname, req.method, body, res));
    return;
  }
  
  // Serve dashboard
  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(dashboardHTML);
    return;
  }
  
  res.writeHead(404);
  res.end('Not found');
});

server.listen(CONFIG.port, () => {
  console.log(`🚀 Enhanced Claude Loop Dashboard running at http://localhost:${CONFIG.port}`);
  console.log(`📊 Features: Context monitoring, Custom messages, Loop control`);
});