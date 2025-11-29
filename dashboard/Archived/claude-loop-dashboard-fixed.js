#!/usr/bin/env node

/*
 * InfiniQuest - Family Productivity Software
 * Copyright (C) 2025 Michael Johnson <wholeness@infiniquest.app>
 *
 * Fixed Claude Loop Dashboard - Memory-optimized version
 * 
 * Key fixes:
 * 1. Proper interval management with cleanup
 * 2. Memory-efficient DOM updates
 * 3. Log rotation and limits
 * 4. Chunked log processing
 * 5. Memory usage monitoring
 */

const http = require('http');
const url = require('url');
const fs = require('fs').promises;
const path = require('path');
const { exec, spawn } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

// Configuration
const CONFIG = {
  port: process.env.PORT || 3335,
  logDir: path.join(__dirname, '../../claudeLogs'),
  configFile: path.join(__dirname, 'loop-config.json'),
  contextStateFile: '/tmp/claude_context_state.json',
  pauseFile: '/tmp/claude_loop_paused',
  loopPidFile: '/tmp/claude_loop.pid',
  maxLogLines: 5000, // Default max lines to show
  maxLogMemory: 10 * 1024 * 1024, // 10MB max log memory
};

// Global interval references for proper cleanup
let statusInterval = null;
let logInterval = null;
let memoryMonitorInterval = null;

// Default loop configuration
let loopConfig = {
  delayMinutes: 10,
  useStartTime: false,
  startTime: "09:00",
  contextAware: true,
  contextWarningPercent: 20,
  contextCriticalPercent: 10,
  customMessage: "Please continue -- Further context: read end of tmp/claudeLogs/claude_YYYY_MM_DD_current.txt",
  enableLogRotation: true,
  maxLogSize: 1048576, // 1MB
  logRefreshRate: 10, // seconds
  schedule: {
    enabled: false,
    minutes: new Array(1440).fill(true),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  },
  conditionalMessages: {
    morningMessage: {
      enabled: false,
      startHour: 6,
      endHour: 12,
      message: "Good morning! Please continue with the project. Focus on high-priority tasks first."
    },
    afternoonMessage: {
      enabled: false,
      startHour: 12,
      endHour: 18,
      message: "Good afternoon! Please continue. Consider reviewing and testing recent changes."
    },
    eveningMessage: {
      enabled: false,
      startHour: 18,
      endHour: 23,
      message: "Good evening! Please continue. Focus on documentation and cleanup tasks."
    },
    lowContextMessage: {
      enabled: true,
      threshold: 30,
      message: "Please prepare to wrap up current work and create a summary. Context is getting low."
    },
    afterCompactMessage: {
      enabled: true,
      linesAfterCompact: 50,
      message: "Fresh context! Please read the summary above and continue with the next tasks."
    },
    longSessionMessage: {
      enabled: false,
      hoursThreshold: 4,
      message: "Long session detected. Consider taking a break or switching to lighter tasks."
    }
  }
};

// Memory monitoring
let memoryUsage = {
  logs: 0,
  total: 0,
  lastCheck: Date.now()
};

// Load saved configuration
async function loadConfig() {
  try {
    const data = await fs.readFile(CONFIG.configFile, 'utf-8');
    const savedConfig = JSON.parse(data);
    loopConfig = { ...loopConfig, ...savedConfig };
  } catch (e) {
    // Use defaults if no config file
  }
}

// Save configuration
async function saveConfig() {
  try {
    await fs.writeFile(CONFIG.configFile, JSON.stringify(loopConfig, null, 2));
    console.log('Config saved to:', CONFIG.configFile);
  } catch (error) {
    console.error('Error saving config:', error);
    throw error;
  }
}

// Memory-efficient log reading with chunking
async function getRecentLogs(maxLines = null) {
  try {
    const currentLogPath = path.join(CONFIG.logDir, `claude_${new Date().toISOString().split('T')[0]}_current.txt`);
    const stats = await fs.stat(currentLogPath);
    
    // Check file size to prevent memory issues
    if (stats.size > CONFIG.maxLogMemory) {
      // Read only the tail of the file
      const bytesToRead = Math.min(stats.size, CONFIG.maxLogMemory);
      const buffer = Buffer.alloc(bytesToRead);
      const fd = await fs.open(currentLogPath, 'r');
      await fd.read(buffer, 0, bytesToRead, stats.size - bytesToRead);
      await fd.close();
      
      const content = buffer.toString('utf-8');
      const lines = content.split('\n');
      
      if (maxLines && maxLines > 0) {
        return lines.slice(-maxLines).join('\n');
      }
      return content;
    } else {
      // File is small enough to read entirely
      const content = await fs.readFile(currentLogPath, 'utf-8');
      
      if (!maxLines || maxLines === 0) {
        return content;
      }
      
      const lines = content.split('\n');
      return lines.slice(-maxLines).join('\n');
    }
  } catch (e) {
    console.error('Error reading logs:', e);
    return '';
  }
}

// API endpoints
async function handleAPI(pathname, method, body, res, parsedUrl) {
  try {
    switch (pathname) {
      case '/api/config':
        if (method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(loopConfig));
        } else if (method === 'POST') {
          const newConfig = JSON.parse(body);
          loopConfig = { ...loopConfig, ...newConfig };
          await saveConfig();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        }
        break;

      case '/api/status':
        const status = await getLoopStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
        break;

      case '/api/logs':
        const maxLines = parsedUrl.query.maxLines ? parseInt(parsedUrl.query.maxLines) : CONFIG.maxLogLines;
        const logs = await getRecentLogs(maxLines === 0 ? null : maxLines);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ logs, memoryUsage }));
        break;

      case '/api/context':
        const context = await getContextStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(context));
        break;

      case '/api/control':
        if (method === 'POST') {
          const data = JSON.parse(body);
          switch (data.action) {
            case 'start':
              await startLoop();
              break;
            case 'stop':
              await stopLoop();
              break;
            case 'pause':
              await pauseLoop();
              break;
            case 'resume':
              await resumeLoop();
              break;
            case 'send-message':
              await sendCustomMessage(data.message);
              break;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        }
        break;

      case '/api/next-message':
        const message = await getConditionalMessage();
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(message);
        break;

      case '/api/pause-status':
        const pauseStatus = await getPauseStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(pauseStatus));
        break;

      case '/api/auto-resume-status':
        const autoResumeStatus = await checkAutoResumeRunning();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(autoResumeStatus));
        break;

      case '/api/start-auto-resume':
        if (method === 'POST') {
          await startAutoResume();
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
    let pid = null;
    try {
      pid = await fs.readFile(CONFIG.loopPidFile, 'utf-8');
      pid = pid.trim();
    } catch (e) {}

    let running = false;
    if (pid) {
      try {
        await execAsync(`ps -p ${pid}`);
        running = true;
      } catch (e) {
        await fs.unlink(CONFIG.loopPidFile).catch(() => {});
      }
    }
    
    const isPaused = await fs.access(CONFIG.pauseFile).then(() => true).catch(() => false);
    
    return {
      running,
      paused: isPaused,
      pid: running ? pid : null,
      config: loopConfig
    };
  } catch (error) {
    return { running: false, paused: false, error: error.message };
  }
}

async function getContextStatus() {
  try {
    const currentLog = path.join(CONFIG.logDir, `claude_${new Date().toISOString().split('T')[0]}_current.txt`);
    const stat = await fs.stat(currentLog);
    const logSize = stat.size;
    
    // More efficient: read only last portion of file for compact detection
    const tailSize = Math.min(50000, logSize); // Read last 50KB max
    const buffer = Buffer.alloc(tailSize);
    const fd = await fs.open(currentLog, 'r');
    await fd.read(buffer, 0, tailSize, logSize - tailSize);
    await fd.close();
    
    const tailContent = buffer.toString('utf-8');
    const lines = tailContent.split('\n');
    let lastCompactLine = -1;
    
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes('/compact')) {
        lastCompactLine = i;
        break;
      }
    }
    
    // Estimate context usage
    let bytesAfterCompact = logSize;
    if (lastCompactLine >= 0) {
      const linesAfterCompact = lines.length - lastCompactLine;
      bytesAfterCompact = linesAfterCompact * 100; // Rough estimate
    }
    
    const maxContextBytes = 800000; // ~200k tokens
    const percentUsed = Math.min(100, (bytesAfterCompact / maxContextBytes) * 100);
    const percentRemaining = Math.max(0, 100 - percentUsed);
    
    return {
      contextPercent: Math.round(percentRemaining),
      timestamp: new Date().toISOString(),
      logSize,
      lastCompact: lastCompactLine >= 0 ? lines.length - lastCompactLine : null
    };
  } catch (e) {
    return { contextPercent: 100, timestamp: new Date().toISOString() };
  }
}

async function getConditionalMessage() {
  const now = new Date();
  const hour = now.getHours();
  const config = loopConfig.conditionalMessages;
  
  try {
    const context = await getContextStatus();
    
    if (config.afterCompactMessage?.enabled && context.lastCompact && context.lastCompact <= config.afterCompactMessage.linesAfterCompact) {
      return config.afterCompactMessage.message;
    }
    
    if (config.lowContextMessage?.enabled && context.contextPercent <= config.lowContextMessage.threshold) {
      let message = config.lowContextMessage.message;
      if (config.lowContextMessage.autoCompact) {
        message += '\n\nAlso, when you\'re ready to compact, please reply with this exact phrase: "Let\'s compact!"';
      }
      return message;
    }
  } catch (e) {}
  
  if (config.longSessionMessage?.enabled) {
    try {
      const logPath = path.join(CONFIG.logDir, `claude_${new Date().toISOString().split('T')[0]}_current.txt`);
      const stat = await fs.stat(logPath);
      const hoursSinceStart = (Date.now() - stat.birthtime.getTime()) / (1000 * 60 * 60);
      if (hoursSinceStart >= config.longSessionMessage.hoursThreshold) {
        return config.longSessionMessage.message;
      }
    } catch (e) {}
  }
  
  if (config.morningMessage?.enabled && hour >= config.morningMessage.startHour && hour < config.morningMessage.endHour) {
    return config.morningMessage.message;
  }
  if (config.afternoonMessage?.enabled && hour >= config.afternoonMessage.startHour && hour < config.afternoonMessage.endHour) {
    return config.afternoonMessage.message;
  }
  if (config.eveningMessage?.enabled && hour >= config.eveningMessage.startHour && hour < config.eveningMessage.endHour) {
    return config.eveningMessage.message;
  }
  
  return loopConfig.customMessage;
}

async function startLoop() {
  await stopLoop();
  
  const enhancedScript = path.join(__dirname, '..', 'claude-loop-enhanced-v2.sh');
  exec(`cd ${path.join(__dirname, '..')} && nohup ./claude-loop-enhanced-v2.sh > /tmp/claude-loop.log 2>&1 &`);
  
  setTimeout(async () => {
    try {
      const { stdout } = await execAsync('pgrep -f "claude-loop-enhanced-v2.sh"');
      if (stdout.trim()) {
        await fs.writeFile(CONFIG.loopPidFile, stdout.trim());
      }
    } catch (e) {}
  }, 1000);
}

async function stopLoop() {
  try {
    const pid = await fs.readFile(CONFIG.loopPidFile, 'utf-8');
    await execAsync(`kill ${pid.trim()}`);
    await fs.unlink(CONFIG.loopPidFile).catch(() => {});
  } catch (e) {
    await execAsync('pkill -f claude-loop-wrapper.sh').catch(() => {});
  }
}

async function pauseLoop() {
  await fs.writeFile(CONFIG.pauseFile, new Date().toISOString());
}

async function resumeLoop() {
  await fs.unlink(CONFIG.pauseFile).catch(() => {});
}

async function getPauseStatus() {
  try {
    const isPaused = await fs.access(CONFIG.pauseFile).then(() => true).catch(() => false);
    
    if (isPaused) {
      try {
        const resumeTimeContent = await fs.readFile(CONFIG.resumeTimeFile, 'utf-8');
        return {
          paused: true,
          resumeTime: resumeTimeContent.trim()
        };
      } catch (e) {
        return { paused: true, resumeTime: null };
      }
    }
    
    return { paused: false };
  } catch (error) {
    return { paused: false, error: error.message };
  }
}

async function checkAutoResumeRunning() {
  try {
    const { stdout } = await execAsync('pgrep -f "claude-loop-auto-resume.sh"');
    return { running: true, pid: stdout.trim() };
  } catch (e) {
    return { running: false };
  }
}

async function startAutoResume() {
  try {
    const autoResumeScript = path.join(__dirname, 'claude-loop-auto-resume.sh');
    exec(`nohup "${autoResumeScript}" > /tmp/claude-auto-resume.log 2>&1 &`);
    return true;
  } catch (error) {
    console.error('Failed to start auto-resume:', error);
    throw error;
  }
}

async function sendCustomMessage(message) {
  await execAsync(`tmux send-keys -t claude "${message.replace(/"/g, '\\"')}"`);
  await new Promise(resolve => setTimeout(resolve, 100));
  await execAsync(`tmux send-keys -t claude Enter`);
}

// Monitor memory usage
function updateMemoryUsage() {
  const usage = process.memoryUsage();
  memoryUsage = {
    logs: usage.heapUsed,
    total: usage.rss,
    lastCheck: Date.now()
  };
  
  // Log warning if memory usage is high
  if (usage.heapUsed > 100 * 1024 * 1024) { // 100MB
    console.warn('High memory usage detected:', Math.round(usage.heapUsed / 1024 / 1024), 'MB');
  }
}

// Dashboard HTML with optimized client-side code
const dashboardHTML = `
<!DOCTYPE html>
<html>
<head>
  <title>Claude Loop Control - Fixed</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    :root {
      --bg-primary: #0a0a0a;
      --bg-secondary: #1a1a1a;
      --bg-tertiary: #2a2a2a;
      --text-primary: #e0e0e0;
      --text-secondary: #a0a0a0;
      --accent: #4fc3f7;
      --success: #4CAF50;
      --warning: #ff9800;
      --danger: #f44336;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      margin: 0;
      padding: 0;
      background: var(--bg-primary);
      color: var(--text-primary);
    }
    
    .header {
      background: var(--bg-secondary);
      padding: 20px;
      border-bottom: 1px solid var(--bg-tertiary);
    }
    
    .header h1 {
      margin: 0;
      color: var(--accent);
      display: flex;
      align-items: center;
      gap: 15px;
    }
    
    .container {
      max-width: 1800px;
      margin: 0 auto;
      padding: 20px 15px;
    }
    
    .grid {
      display: grid;
      grid-template-columns: 450px 1fr;
      gap: 20px;
      margin-top: 20px;
    }
    
    .card {
      background: var(--bg-secondary);
      border-radius: 12px;
      padding: 20px;
      border: 1px solid var(--bg-tertiary);
    }
    
    .card h2 {
      margin-top: 0;
      color: var(--accent);
      font-size: 18px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    
    .status-bar {
      display: flex;
      align-items: center;
      gap: 20px;
      padding: 15px;
      background: var(--bg-tertiary);
      border-radius: 8px;
      margin-bottom: 20px;
    }
    
    .status-indicator {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      animation: pulse 2s infinite;
    }
    
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    
    .running { background: var(--success); }
    .paused { background: var(--warning); }
    .stopped { background: var(--danger); }
    
    .control-group {
      margin-bottom: 20px;
    }
    
    .control-group label {
      display: block;
      margin-bottom: 5px;
      color: var(--text-secondary);
      font-size: 14px;
    }
    
    .control-group input,
    .control-group textarea,
    .control-group select {
      width: 100%;
      padding: 10px;
      background: var(--bg-tertiary);
      border: 1px solid #444;
      border-radius: 6px;
      color: var(--text-primary);
      font-family: inherit;
    }
    
    .control-group input[type="number"] {
      width: 100px;
    }
    
    .control-group input[type="checkbox"] {
      width: auto;
      margin-right: 8px;
    }
    
    .checkbox-group {
      display: flex;
      align-items: center;
      margin: 10px 0;
    }
    
    .button {
      padding: 10px 20px;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.3s;
      margin-right: 10px;
    }
    
    .button:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }
    
    .button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
    }
    
    .button-primary { background: var(--accent); color: #000; }
    .button-success { background: var(--success); color: white; }
    .button-danger { background: var(--danger); color: white; }
    .button-warning { background: var(--warning); color: #000; }
    
    .button-group {
      display: flex;
      gap: 10px;
      margin-top: 20px;
    }
    
    .context-meter {
      margin: 20px 0;
    }
    
    .context-bar {
      height: 30px;
      background: var(--bg-tertiary);
      border-radius: 15px;
      overflow: hidden;
      position: relative;
    }
    
    .context-fill {
      height: 100%;
      background: linear-gradient(90deg, var(--success), #8BC34A);
      transition: width 0.3s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #000;
      font-weight: bold;
    }
    
    .context-warning {
      background: linear-gradient(90deg, var(--warning), #ffb74d);
    }
    
    .context-critical {
      background: linear-gradient(90deg, var(--danger), #ef5350);
    }
    
    .log-viewer {
      background: var(--bg-primary);
      border: 1px solid var(--bg-tertiary);
      border-radius: 8px 8px 0 0;
      padding: 15px;
      height: 600px;
      overflow-y: auto;
      font-family: 'Menlo', 'DejaVu Sans Mono', 'Ubuntu Mono', 'Consolas', 'Monaco', 'Liberation Mono', 'Courier New', monospace;
      font-size: 13px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-wrap: break-word;
      color: var(--text-primary);
      font-variant-ligatures: none;
      -webkit-font-smoothing: auto;
      -moz-osx-font-smoothing: auto;
      letter-spacing: normal;
      tab-size: 8;
      -moz-tab-size: 8;
      -o-tab-size: 8;
    }
    
    .memory-warning {
      background: var(--warning);
      color: #000;
      padding: 10px;
      border-radius: 6px;
      margin-bottom: 10px;
      font-size: 14px;
      display: none;
    }
    
    .stats-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-top: 15px;
    }
    
    .stat-item {
      background: var(--bg-tertiary);
      padding: 10px;
      border-radius: 6px;
    }
    
    .stat-label {
      font-size: 12px;
      color: var(--text-secondary);
    }
    
    .stat-value {
      font-size: 18px;
      font-weight: bold;
      color: var(--accent);
    }
    
    .divider {
      height: 1px;
      background: var(--bg-tertiary);
      margin: 20px 0;
    }
    
    @media (max-width: 1200px) {
      .grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="container">
      <h1>🎮 Claude Loop Control (Fixed)</h1>
    </div>
  </div>
  
  <div class="container">
    <div class="status-bar">
      <div class="status-indicator stopped" id="status-indicator"></div>
      <div id="status-text">Checking...</div>
      <div style="flex: 1;"></div>
      <div id="pid-info"></div>
    </div>
    
    <div class="grid">
      <!-- Configuration Panel -->
      <div class="card">
        <h2>⚙️ Configuration</h2>
        
        <div class="control-group">
          <label>Delay Between Messages (minutes)</label>
          <input type="number" id="delay-minutes" min="1" max="60" value="10">
        </div>
        
        <div class="checkbox-group">
          <label>
            <input type="checkbox" id="context-aware" checked>
            Enable Context-Aware Mode
          </label>
        </div>
        
        <div class="control-group" id="context-settings">
          <label>Context Warning Threshold (%)</label>
          <input type="number" id="context-warning" min="10" max="50" value="20">
          
          <label style="margin-top: 10px;">Context Critical Threshold (%)</label>
          <input type="number" id="context-critical" min="5" max="30" value="10">
        </div>
        
        <div class="divider"></div>
        
        <h3 style="font-size: 16px; margin: 10px 0;">Log Management</h3>
        
        <div class="control-group">
          <label style="font-size: 12px;">Log Refresh Rate (seconds)</label>
          <input type="number" id="log-refresh-rate" min="5" max="60" value="10" style="width: 80px;">
          <div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">
            Minimum 5 seconds to prevent memory issues
          </div>
        </div>
        
        <div class="divider"></div>
        
        <div class="control-group">
          <label>Custom Message</label>
          <textarea id="custom-message" rows="3" placeholder="Message to send with each loop..."></textarea>
        </div>
        
        <div style="color: var(--text-secondary); font-size: 12px; margin-top: 20px; text-align: center;">
          ✨ Settings auto-save as you type
        </div>
      </div>
      
      <!-- Log Viewer -->
      <div class="card">
        <h2>📜 Live Logs</h2>
        
        <div class="memory-warning" id="memory-warning">
          ⚠️ High memory usage detected. Consider reducing log lines or refresh rate.
        </div>
        
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
          <div>
            <label style="margin-right: 10px;">Show last:</label>
            <select id="log-lines-select" onchange="updateLogLines()" style="padding: 4px 8px; border-radius: 4px; background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--bg-tertiary);">
              <option value="100">100 lines</option>
              <option value="500">500 lines</option>
              <option value="1000">1000 lines</option>
              <option value="5000" selected>5000 lines</option>
            </select>
          </div>
          <div style="font-size: 12px; color: var(--text-secondary);">
            <span id="log-info">-</span>
            <span id="memory-info" style="margin-left: 10px;">-</span>
            <button onclick="scrollLogsToBottom()" style="margin-left: 10px; padding: 2px 8px; font-size: 11px; background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--bg-tertiary); border-radius: 4px; cursor: pointer;">
              ↓ Bottom
            </button>
          </div>
        </div>
        
        <div class="log-viewer" id="logs">
          Loading logs...
        </div>
        
        <!-- Message Input Area -->
        <div class="message-input-area" style="
          display: flex;
          gap: 10px;
          margin-top: 15px;
          padding: 15px;
          background: var(--bg-tertiary);
          border-radius: 0 0 8px 8px;
          border-top: 1px solid var(--border);
        ">
          <textarea 
            id="quick-message" 
            rows="2" 
            placeholder="Type a message for Claude..."
            style="
              flex: 1;
              padding: 12px;
              background: var(--bg-secondary);
              color: var(--text-primary);
              border: 1px solid var(--border);
              border-radius: 8px;
              font-family: inherit;
              font-size: 14px;
              resize: vertical;
              min-height: 44px;
            "
            onkeydown="if(event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); }"
          ></textarea>
          <button 
            class="button button-success" 
            onclick="sendMessage()"
            style="
              align-self: flex-end;
              padding: 12px 24px;
              display: flex;
              align-items: center;
              gap: 8px;
              font-size: 14px;
              font-weight: 500;
              white-space: nowrap;
            "
          >
            <span>Send</span>
            <span style="font-size: 16px;">→</span>
          </button>
        </div>
      </div>
      
      <!-- Status & Control Panel -->
      <div class="card">
        <h2>🎯 Status & Control</h2>
        
        <div class="context-meter">
          <h3 style="margin: 0 0 10px 0; font-size: 16px;">Context Usage</h3>
          <div class="context-bar">
            <div class="context-fill" id="context-fill" style="width: 100%">
              100%
            </div>
          </div>
          <div style="color: var(--text-secondary); font-size: 12px; margin-top: 5px;">
            <span id="context-info">Calculating...</span>
          </div>
        </div>
        
        <div class="stats-grid">
          <div class="stat-item">
            <div class="stat-label">Log Size</div>
            <div class="stat-value" id="log-size">-</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">Lines Since Compact</div>
            <div class="stat-value" id="lines-since-compact">-</div>
          </div>
        </div>
        
        <div class="divider"></div>
        
        <h3 style="font-size: 16px;">Loop Control</h3>
        <div class="button-group">
          <button id="start-btn" class="button button-success" onclick="controlLoop('start')">
            ▶️ Start
          </button>
          <button id="stop-btn" class="button button-danger" onclick="controlLoop('stop')">
            ⏹️ Stop
          </button>
        </div>
        
        <div class="button-group">
          <button id="pause-btn" class="button button-warning" onclick="controlLoop('pause')">
            ⏸️ Pause
          </button>
          <button id="resume-btn" class="button button-success" onclick="controlLoop('resume')">
            ▶️ Resume
          </button>
        </div>
      </div>
    </div>
  </div>
  
  <script>
    // Global state with proper initialization
    let statusInterval = null;
    let logInterval = null;
    let currentConfig = {};
    let currentLogLines = 5000;
    let logRefreshRate = 10000; // milliseconds
    let lastLogContent = '';
    let isUpdatingLogs = false;
    
    // Cleanup function
    function cleanup() {
      console.log('Cleaning up intervals...');
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
      }
      if (logInterval) {
        clearInterval(logInterval);
        logInterval = null;
      }
    }
    
    // Add cleanup on page unload
    window.addEventListener('beforeunload', cleanup);
    window.addEventListener('unload', cleanup);
    
    // Helper functions
    function setElementValue(id, value, property = 'value') {
      const element = document.getElementById(id);
      if (element) {
        element[property] = value;
      }
    }
    
    function getElementValue(id, property = 'value', defaultValue = '') {
      const element = document.getElementById(id);
      return element ? element[property] : defaultValue;
    }
    
    async function loadConfig() {
      try {
        const response = await fetch('/api/config');
        currentConfig = await response.json();
        
        // Update UI
        setElementValue('delay-minutes', currentConfig.delayMinutes);
        setElementValue('context-aware', currentConfig.contextAware, 'checked');
        setElementValue('context-warning', currentConfig.contextWarningPercent);
        setElementValue('context-critical', currentConfig.contextCriticalPercent);
        setElementValue('custom-message', currentConfig.customMessage);
        setElementValue('log-refresh-rate', currentConfig.logRefreshRate || 10);
        
        // Update refresh rate
        logRefreshRate = (currentConfig.logRefreshRate || 10) * 1000;
        
        updateContextSettings();
      } catch (error) {
        console.error('Failed to load config:', error);
      }
    }
    
    async function saveConfig() {
      const config = {
        delayMinutes: parseInt(getElementValue('delay-minutes', 'value', '10')),
        contextAware: getElementValue('context-aware', 'checked', true),
        contextWarningPercent: parseInt(getElementValue('context-warning', 'value', '20')),
        contextCriticalPercent: parseInt(getElementValue('context-critical', 'value', '10')),
        customMessage: getElementValue('custom-message', 'value', 'Please continue'),
        logRefreshRate: parseInt(getElementValue('log-refresh-rate', 'value', '10'))
      };
      
      try {
        await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config)
        });
        
        // Update local refresh rate
        logRefreshRate = config.logRefreshRate * 1000;
        restartLogInterval();
      } catch (error) {
        console.error('Failed to save config:', error);
      }
    }
    
    async function updateStatus() {
      try {
        const response = await fetch('/api/status');
        const status = await response.json();
        
        const indicator = document.getElementById('status-indicator');
        const text = document.getElementById('status-text');
        const pidInfo = document.getElementById('pid-info');
        
        if (status.running) {
          if (status.paused) {
            indicator.className = 'status-indicator paused';
            text.textContent = 'Loop is paused';
          } else {
            indicator.className = 'status-indicator running';
            text.textContent = 'Loop is running';
          }
          pidInfo.textContent = 'PID: ' + status.pid;
        } else {
          indicator.className = 'status-indicator stopped';
          text.textContent = 'Loop is stopped';
          pidInfo.textContent = '';
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
        const logSize = document.getElementById('log-size');
        const linesSince = document.getElementById('lines-since-compact');
        
        const percent = context.contextPercent || 100;
        fill.style.width = percent + '%';
        fill.textContent = percent + '%';
        
        // Update color based on percentage
        fill.className = 'context-fill';
        if (percent <= currentConfig.contextCriticalPercent) {
          fill.classList.add('context-critical');
        } else if (percent <= currentConfig.contextWarningPercent) {
          fill.classList.add('context-warning');
        }
        
        // Update info
        info.textContent = 'Last updated: ' + new Date(context.timestamp).toLocaleTimeString();
        logSize.textContent = context.logSize ? (context.logSize / 1024).toFixed(1) + ' KB' : '-';
        linesSince.textContent = context.lastCompact || 'No compact';
      } catch (error) {
        console.error('Failed to update context:', error);
      }
    }
    
    // Optimized log update function
    async function updateLogs() {
      if (isUpdatingLogs) {
        console.log('Skipping log update - previous update still in progress');
        return;
      }
      
      isUpdatingLogs = true;
      
      try {
        const response = await fetch(\`/api/logs?maxLines=\${currentLogLines}\`);
        const data = await response.json();
        
        // Check memory usage
        if (data.memoryUsage) {
          const memoryMB = data.memoryUsage.logs / 1024 / 1024;
          const memoryInfo = document.getElementById('memory-info');
          memoryInfo.textContent = \`Mem: \${memoryMB.toFixed(1)}MB\`;
          
          // Show warning if memory is high
          const memoryWarning = document.getElementById('memory-warning');
          if (memoryMB > 50) {
            memoryWarning.style.display = 'block';
          } else {
            memoryWarning.style.display = 'none';
          }
        }
        
        const logsEl = document.getElementById('logs');
        
        if (!data.logs) {
          logsEl.textContent = 'No logs available';
          return;
        }
        
        // Only update if content changed
        if (data.logs === lastLogContent) {
          return;
        }
        
        lastLogContent = data.logs;
        
        // Check if user is at bottom
        const wasAtBottom = (logsEl.scrollTop + logsEl.clientHeight) >= (logsEl.scrollHeight - 10);
        
        // Use more efficient update method
        const lines = data.logs.split('\\n');
        const fragment = document.createDocumentFragment();
        
        // Process in chunks to avoid blocking
        const chunkSize = 100;
        for (let i = 0; i < lines.length; i += chunkSize) {
          const chunk = lines.slice(i, i + chunkSize);
          chunk.forEach(line => {
            const div = document.createElement('div');
            div.textContent = line;
            
            // Add color coding
            if (line.includes('[ERROR]') || line.includes('error:')) {
              div.style.color = 'var(--danger)';
            } else if (line.includes('[WARNING]') || line.includes('⚠️')) {
              div.style.color = 'var(--warning)';
            } else if (line.includes('[SUCCESS]') || line.includes('✅')) {
              div.style.color = 'var(--success)';
            } else if (line.includes('[INFO]') || line.includes('ℹ️')) {
              div.style.color = 'var(--accent)';
            } else if (line.startsWith('Human:') || line.startsWith('Assistant:')) {
              div.style.color = 'var(--accent)';
              div.style.fontWeight = 'bold';
            }
            
            fragment.appendChild(div);
          });
        }
        
        // Clear and update
        logsEl.innerHTML = '';
        logsEl.appendChild(fragment);
        
        // Auto-scroll if was at bottom
        if (wasAtBottom) {
          logsEl.scrollTop = logsEl.scrollHeight;
        }
        
        // Update log info
        const logInfo = document.getElementById('log-info');
        const lineCount = lines.length;
        const sizeKB = (data.logs.length / 1024).toFixed(1);
        logInfo.textContent = \`\${lineCount} lines, \${sizeKB} KB\`;
        
      } catch (error) {
        console.error('Failed to update logs:', error);
      } finally {
        isUpdatingLogs = false;
      }
    }
    
    function updateLogLines() {
      const select = document.getElementById('log-lines-select');
      currentLogLines = parseInt(select.value);
      updateLogs();
    }
    
    function scrollLogsToBottom() {
      const logsEl = document.getElementById('logs');
      logsEl.scrollTop = logsEl.scrollHeight;
    }
    
    async function controlLoop(action) {
      try {
        await fetch('/api/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action })
        });
        
        setTimeout(updateStatus, 1000);
      } catch (error) {
        console.error('Control error:', error);
      }
    }
    
    async function sendMessage() {
      const messageInput = document.getElementById('quick-message');
      const message = messageInput.value.trim();
      if (!message) return;
      
      try {
        await fetch('/api/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'send-message', message })
        });
        
        messageInput.value = '';
        messageInput.focus();
        
        // Show feedback
        const statusText = document.getElementById('status-text');
        const originalText = statusText.textContent;
        statusText.textContent = '✅ Message sent!';
        setTimeout(() => {
          statusText.textContent = originalText;
        }, 2000);
      } catch (error) {
        console.error('Send message error:', error);
        alert('Failed to send message: ' + error.message);
      }
    }
    
    function updateContextSettings() {
      const enabled = document.getElementById('context-aware').checked;
      document.getElementById('context-settings').style.display = enabled ? 'block' : 'none';
    }
    
    function restartLogInterval() {
      if (logInterval) {
        clearInterval(logInterval);
      }
      logInterval = setInterval(updateLogs, logRefreshRate);
    }
    
    // Auto-save with debouncing
    let saveTimeout;
    function autoSave() {
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(saveConfig, 500);
    }
    
    // Event listeners
    document.getElementById('context-aware').addEventListener('change', () => {
      updateContextSettings();
      autoSave();
    });
    
    document.getElementById('log-refresh-rate').addEventListener('change', (e) => {
      const value = parseInt(e.target.value);
      if (value < 5) {
        e.target.value = 5;
        alert('Minimum refresh rate is 5 seconds to prevent memory issues');
      }
      autoSave();
    });
    
    // Add auto-save to all inputs
    document.querySelectorAll('input, textarea, select').forEach(input => {
      if (input.type === 'checkbox') {
        input.addEventListener('change', autoSave);
      } else {
        input.addEventListener('input', autoSave);
      }
    });
    
    // Initialize
    async function init() {
      await loadConfig();
      await updateStatus();
      await updateContext();
      await updateLogs();
      
      // Start intervals
      statusInterval = setInterval(() => {
        updateStatus();
        updateContext();
      }, 5000);
      
      logInterval = setInterval(updateLogs, logRefreshRate);
    }
    
    // Start the app
    init();
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
    req.on('end', () => handleAPI(pathname, req.method, body, res, parsedUrl));
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

// Cleanup function
function shutdownGracefully() {
  console.log('\nShutting down gracefully...');
  
  // Clear all intervals
  if (statusInterval) clearInterval(statusInterval);
  if (logInterval) clearInterval(logInterval);
  if (memoryMonitorInterval) clearInterval(memoryMonitorInterval);
  
  // Close server
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
  
  // Force exit after 5 seconds
  setTimeout(() => {
    console.log('Forcing exit...');
    process.exit(0);
  }, 5000);
}

// Handle process termination
process.on('SIGINT', shutdownGracefully);
process.on('SIGTERM', shutdownGracefully);

// Initialize
loadConfig().then(() => {
  // Start memory monitoring
  memoryMonitorInterval = setInterval(updateMemoryUsage, 30000); // Every 30 seconds
  
  server.listen(CONFIG.port, '0.0.0.0', () => {
    console.log(`🎮 Claude Loop Dashboard (Fixed) running at:`);
    console.log(`   - http://localhost:${CONFIG.port}`);
    console.log(`   - http://192.168.1.2:${CONFIG.port}`);
    console.log(`✨ Key Improvements:`);
    console.log(`   - Memory-efficient log handling`);
    console.log(`   - Proper interval cleanup`);
    console.log(`   - Chunked log processing`);
    console.log(`   - Memory usage monitoring`);
    console.log(`   - Graceful shutdown handling`);
  });
});