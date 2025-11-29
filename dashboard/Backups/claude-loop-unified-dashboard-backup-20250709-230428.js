#!/usr/bin/env node

/*
 * InfiniQuest - Family Productivity Software
 * Copyright (C) 2025 Michael Johnson <wholeness@infiniquest.app>
 *
 * Unified Claude Loop Dashboard - All controls in one place
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
  maxLogLines: 1000, // Reduced for performance
};

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
  schedule: {
    enabled: false,
    // 1440 minutes, each minute can be active (true) or inactive (false)
    // Index 0 = 12:00 AM local time, Index 60 = 1:00 AM local time, etc.
    minutes: new Array(1440).fill(true), // Default: all minutes active
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

// Execute shell command
async function execCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && !cmd.includes('2>/dev/null')) {
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

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
        const sessionName = parsedUrl.query.session || null;
        const logs = await getRecentLogs(maxLines === 0 ? null : maxLines, sessionName);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ logs }));
        break;

      case '/api/context':
        const context = await getContextStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(context));
        break;

      case '/api/log-monitor':
        if (method === 'POST') {
          const data = JSON.parse(body);
          const instance = data.instance || 'default';
          const session = data.session || 'claude-chat';
          let command = `/home/michael/InfiniQuest/tmp/claudeLoop/dashboard/log-monitor-manager.sh ${data.action} ${instance}`;
          if (data.action === 'start' && data.session) {
            command += ` ${session}`;
          }
          const result = await execCommand(command);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: result.includes('OK:'), message: result }));
        }
        break;
        
      case '/api/log-monitor/status':
        const instance = parsedUrl.query.instance || 'default';
        const statusResult = await execCommand(`/home/michael/InfiniQuest/tmp/claudeLoop/dashboard/log-monitor-manager.sh status ${instance}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(statusResult);
        break;
        
      case '/api/log-monitor/list':
        const listResult = await execCommand('/home/michael/InfiniQuest/tmp/claudeLoop/dashboard/log-monitor-manager.sh list');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(listResult);
        break;
        
      case '/api/tmux-sessions':
        const tmuxSessions = await execCommand('tmux list-sessions -F "#{session_name}" 2>/dev/null || echo ""');
        const sessions = tmuxSessions.trim().split('\n').filter(s => s);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sessions }));
        break;
        
      case '/api/tmux-setup':
        if (method === 'POST') {
          const setupData = JSON.parse(body);
          const session = setupData.session || 'claude-chat';
          const action = setupData.action || 'ensure';
          const setupResult = await execCommand(`/home/michael/InfiniQuest/tmp/claudeLoop/dashboard/tmux-claude-setup.sh ${session} ${action}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: setupResult }));
        }
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
              await sendCustomMessage(data.message, data.session || 'claude');
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
    // Check if loop process is running
    let pid = null;
    try {
      pid = await fs.readFile(CONFIG.loopPidFile, 'utf-8');
      pid = pid.trim();
    } catch (e) {}

    let running = false;
    if (pid) {
      try {
        // Check if process is actually running
        await execAsync(`ps -p ${pid}`);
        running = true;
      } catch (e) {
        // Process not found
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
    // Estimate context from log file
    const currentLog = path.join(CONFIG.logDir, `claude_${new Date().toISOString().split('T')[0]}_current.txt`);
    const stat = await fs.stat(currentLog);
    const logSize = stat.size;
    
    // Look for last compact
    const content = await fs.readFile(currentLog, 'utf-8');
    const lines = content.split('\n');
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

async function getRecentLogs(maxLines = null, sessionName = null) {
  try {
    // We can't check monitor status from server-side
    // Just try to read the log file and handle if it doesn't exist
    
    // Look for ANSI display logs first
    const ansiLogDir = path.join(CONFIG.logDir, 'ANSI_tmp');
    // Use provided session or default
    const session = sessionName || 'claude-loop1';
    // ANSI logs have no date, just session name
    let currentLogPath = path.join(ansiLogDir, `${session}.log`);
    
    try {
      const content = await fs.readFile(currentLogPath, 'utf-8');
      
      // If maxLines is null or 0, return entire file
      if (!maxLines) {
        return content;
      }
      
      const lines = content.split('\n');
      return lines.slice(-maxLines).join('\n');
    } catch (error) {
      // Log file doesn't exist yet - this is normal when monitor hasn't started
      return '';
    }
  } catch (e) {
    console.error('Error reading logs:', e);
    return '';
  }
}

async function getConditionalMessage() {
  const now = new Date();
  const hour = now.getHours();
  const config = loopConfig.conditionalMessages;
  
  // Priority order (first match wins):
  // 1. Context-critical messages (most important)
  try {
    const context = await getContextStatus();
    
    // After compact message (highest priority - fresh context needs direction)
    if (config.afterCompactMessage?.enabled && context.lastCompact && context.lastCompact <= config.afterCompactMessage.linesAfterCompact) {
      return config.afterCompactMessage.message;
    }
    
    // Low context message (high priority - needs action)
    if (config.lowContextMessage?.enabled && context.contextPercent <= config.lowContextMessage.threshold) {
      let message = config.lowContextMessage.message;
      // Add auto-compact instruction if enabled
      if (config.lowContextMessage.autoCompact) {
        message += '\n\nAlso, when you\'re ready to compact, please reply with this exact phrase: "Let\'s compact!"';
      }
      return message;
    }
  } catch (e) {}
  
  // 2. Session duration (medium priority)
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
  
  // 3. Time-based messages (lower priority - general guidance)
  if (config.morningMessage?.enabled && hour >= config.morningMessage.startHour && hour < config.morningMessage.endHour) {
    return config.morningMessage.message;
  }
  if (config.afternoonMessage?.enabled && hour >= config.afternoonMessage.startHour && hour < config.afternoonMessage.endHour) {
    return config.afternoonMessage.message;
  }
  if (config.eveningMessage?.enabled && hour >= config.eveningMessage.startHour && hour < config.eveningMessage.endHour) {
    return config.eveningMessage.message;
  }
  
  // 4. Default custom message (fallback)
  return loopConfig.customMessage;
}

async function startLoop() {
  // Stop any existing loop
  await stopLoop();
  
  // Use the enhanced loop script which includes the monitor
  // Start the enhanced script in background
  exec(`cd ${path.join(__dirname, '..')} && nohup ./claude-loop-enhanced-v2.sh > /tmp/claude-loop.log 2>&1 &`);
  
  // Save PID for tracking (the script saves its own PID too)
  setTimeout(async () => {
    try {
      const { stdout } = await execAsync('pgrep -f "claude-loop-enhanced-v2.sh"');
      if (stdout.trim()) {
        await fs.writeFile(CONFIG.loopPidFile, stdout.trim());
      }
    } catch (e) {
      // Process might not be found immediately
    }
  }, 1000);
}

async function stopLoop() {
  try {
    const pid = await fs.readFile(CONFIG.loopPidFile, 'utf-8');
    await execAsync(`kill ${pid.trim()}`);
    await fs.unlink(CONFIG.loopPidFile).catch(() => {});
  } catch (e) {
    // Also try to kill any wrapper scripts
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
      // Check for resume time file
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
    // Check if auto-resume process is running
    const { stdout } = await execAsync('pgrep -f "claude-loop-auto-resume.sh"');
    return { running: true, pid: stdout.trim() };
  } catch (e) {
    return { running: false };
  }
}

async function startAutoResume() {
  try {
    // Start the auto-resume monitor
    const autoResumeScript = path.join(__dirname, 'claude-loop-auto-resume.sh');
    exec(`nohup "${autoResumeScript}" > /tmp/claude-auto-resume.log 2>&1 &`);
    return true;
  } catch (error) {
    console.error('Failed to start auto-resume:', error);
    throw error;
  }
}

async function sendCustomMessage(message, session = 'claude') {
  // Send message to tmux session with proper escaping
  // First send the text
  await execAsync(`tmux send-keys -t ${session} "${message.replace(/"/g, '\\"')}"`);
  
  // Small delay to ensure text is processed
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Then send Enter
  await execAsync(`tmux send-keys -t ${session} Enter`);
}

// Dashboard HTML
const dashboardHTML = `
<!DOCTYPE html>
<html>
<head>
  <title>Claude Loop Unified Control</title>
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
      overflow-x: auto;
      max-width: 100%;
      font-family: 'Menlo', 'DejaVu Sans Mono', 'Ubuntu Mono', 'Consolas', 'Monaco', 'Liberation Mono', 'Courier New', monospace;
      font-size: 13px;
      line-height: 1.5;
      white-space: pre;
      word-wrap: normal;
      overflow-wrap: break-word;
      color: var(--text-primary);
      font-variant-ligatures: none;
      -webkit-font-smoothing: auto;
      -moz-osx-font-smoothing: auto;
      letter-spacing: normal;
      tab-size: 8; /* Match terminal tab width */
      -moz-tab-size: 8;
      -o-tab-size: 8;
    }
    
    /* Handle emojis and special characters */
    .log-viewer span.emoji {
      display: inline-block;
      width: 2ch; /* Force emoji to take exactly 2 character widths */
      text-align: center;
      vertical-align: middle;
    }
    
    /* Alternative: make entire log use tabular numbers and fixed layout */
    .log-viewer {
      font-feature-settings: "tnum" 1; /* Tabular numbers */
      text-rendering: optimizeLegibility;
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
    
    /* Horizontal Status & Controls Layout */
    .horizontal-status-bar {
      display: flex;
      align-items: center;
      gap: 20px;
      padding: 15px 20px;
      background: var(--bg-secondary);
      border-radius: 8px;
      margin: 15px 0;
      border: 1px solid var(--bg-tertiary);
    }
    
    .horizontal-controls-bar {
      display: flex;
      align-items: center;
      gap: 15px;
      padding: 12px 20px;
      background: var(--bg-secondary);
      border-radius: 8px;
      margin-bottom: 20px;
      border: 1px solid var(--bg-tertiary);
      justify-content: center;
    }
    
    .compact-context-meter {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 200px;
    }
    
    .compact-context-bar {
      height: 20px;
      width: 120px;
      background: var(--bg-tertiary);
      border-radius: 10px;
      overflow: hidden;
      position: relative;
    }
    
    .compact-context-fill {
      height: 100%;
      background: linear-gradient(90deg, var(--success), #8BC34A);
      transition: width 0.3s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #000;
      font-weight: bold;
      font-size: 12px;
    }
    
    .compact-context-fill.context-warning {
      background: linear-gradient(90deg, var(--warning), #ffb74d);
    }
    
    .compact-context-fill.context-critical {
      background: linear-gradient(90deg, var(--danger), #ef5350);
    }
    
    .horizontal-stat {
      display: flex;
      flex-direction: column;
      align-items: center;
      min-width: 80px;
    }
    
    .horizontal-stat-label {
      font-size: 11px;
      color: var(--text-secondary);
      margin-bottom: 2px;
    }
    
    .horizontal-stat-value {
      font-size: 14px;
      font-weight: bold;
      color: var(--accent);
    }
    
    .compact-button {
      padding: 8px 16px;
      border: none;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.3s;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    
    .compact-button:hover {
      transform: translateY(-1px);
      box-shadow: 0 3px 8px rgba(0,0,0,0.2);
    }
    
    .compact-button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
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
      <h1>🎮 Claude Loop Unified Control</h1>
    </div>
  </div>
  
  <div class="container">
    <!-- Horizontal Status Bar -->
    <div class="horizontal-status-bar">
      <div class="status-indicator stopped" id="status-indicator"></div>
      <div id="status-text">Checking...</div>
      <div id="pid-info" style="font-size: 12px; color: var(--text-secondary);"></div>
      
      <div class="compact-context-meter">
        <span style="font-size: 12px; color: var(--text-secondary);">Context:</span>
        <div class="compact-context-bar">
          <div class="compact-context-fill" id="compact-context-fill" style="width: 100%">
            100%
          </div>
        </div>
      </div>
      
      <div class="horizontal-stat">
        <div class="horizontal-stat-label">Last Updated</div>
        <div class="horizontal-stat-value" id="horizontal-last-updated">-</div>
      </div>
      
      <div class="horizontal-stat">
        <div class="horizontal-stat-label">Log Size</div>
        <div class="horizontal-stat-value" id="horizontal-log-size">-</div>
      </div>
      
      <div class="horizontal-stat">
        <div class="horizontal-stat-label">Lines Since Compact</div>
        <div class="horizontal-stat-value" id="horizontal-lines-since-compact">-</div>
      </div>
    </div>
    
    <!-- Horizontal Controls Bar -->
    <div class="horizontal-controls-bar">
      <div style="display: flex; gap: 5px; align-items: center;">
        <span style="font-size: 11px; color: var(--text-secondary); margin-right: 5px;">Loop:</span>
        <button id="horizontal-start-btn" class="compact-button button-success" onclick="controlLoop('start')">
          ▶️ Start
        </button>
        <button id="horizontal-stop-btn" class="compact-button button-danger" onclick="controlLoop('stop')">
          ⏹️ Stop
        </button>
        <button id="horizontal-pause-btn" class="compact-button button-warning" onclick="controlLoop('pause')">
          ⏸️ Pause
        </button>
        <button id="horizontal-resume-btn" class="compact-button button-success" onclick="controlLoop('resume')">
          ▶️ Resume
        </button>
      </div>
    </div>
    
    <div class="grid" id="main-grid">
      <!-- Configuration Panel -->
      <div class="card" id="config-panel" style="transition: all 0.3s;">
        <h2 style="cursor: pointer; user-select: none;" onclick="toggleConfigPanel()">
          <span id="config-toggle">▼</span> ⚙️ Configuration
        </h2>
        <div id="config-content">
        
        <div class="control-group">
          <label>Delay Between Messages (minutes)</label>
          <input type="number" id="delay-minutes" min="1" max="60" value="10">
        </div>
        
        <div class="checkbox-group">
          <label>
            <input type="checkbox" id="use-start-time">
            Use Start Time (instead of delay)
          </label>
        </div>
        
        <div class="control-group" id="start-time-group" style="display: none;">
          <label>Start Time</label>
          <input type="time" id="start-time" value="09:00">
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
        
        <div class="checkbox-group">
          <label>
            <input type="checkbox" id="enable-log-rotation" checked onchange="updateLogRotationConfig()">
            Enable Log Rotation
          </label>
        </div>
        
        <div id="log-rotation-settings" style="margin-left: 20px;">
          <div class="control-group">
            <label style="font-size: 12px;">Max Log Size (MB)</label>
            <input type="number" id="max-log-size" min="0.5" max="10" step="0.5" value="1" style="width: 60px;">
            <div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">
              Logs rotate daily at midnight or when size is exceeded
            </div>
          </div>
          
          <div class="control-group" style="margin-top: 10px;">
            <label style="font-size: 12px;">Log Refresh Rate (seconds)</label>
            <input type="number" id="log-refresh-rate" min="1" max="60" value="10" style="width: 60px;" onchange="updateLogRefreshRate()">
            <div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">
              How often to fetch new log entries from tmux
            </div>
          </div>
        </div>
        
        <div class="divider"></div>
        
        <div class="checkbox-group">
          <label>
            <input type="checkbox" id="schedule-enabled">
            Enable Time Schedule
          </label>
        </div>
        
        <div id="schedule-settings" style="display: none; margin-top: 15px;">
          <div style="margin-bottom: 10px; display: flex; align-items: center; gap: 15px;">
            <div>
              <label style="font-size: 12px; margin-right: 10px;">Tool:</label>
              <label style="margin-right: 15px; padding: 4px 10px; background: var(--success); color: white; border-radius: 4px; cursor: pointer;">
                <input type="radio" name="schedule-tool" value="active" checked> Active
              </label>
              <label style="padding: 4px 10px; background: #dc3545; color: white; border-radius: 4px; cursor: pointer;">
                <input type="radio" name="schedule-tool" value="inactive"> Inactive
              </label>
            </div>
            <div>
              <label style="font-size: 12px; margin-right: 5px;">Precision:</label>
              <select id="schedule-precision" style="background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--border); padding: 4px 8px; border-radius: 4px;">
                <option value="1">1 min</option>
                <option value="5">5 min</option>
                <option value="10">10 min</option>
                <option value="15" selected>15 min</option>
                <option value="30">30 min</option>
                <option value="60">1 hour</option>
              </select>
            </div>
          </div>
          
          <div style="margin-bottom: 10px; font-size: 12px; color: var(--text-secondary);">
            <span id="timezone-display">Timezone: Loading...</span>
          </div>
          
          <div style="position: relative; margin: 20px 0;">
            <div id="time-tooltip" style="
              position: absolute;
              top: -25px;
              left: 0;
              background: var(--bg-primary);
              border: 1px solid var(--border);
              padding: 2px 8px;
              border-radius: 4px;
              font-size: 11px;
              display: none;
              pointer-events: none;
              z-index: 1000;
            "></div>
            
            <!-- AM Timeline -->
            <div style="margin-bottom: 10px;">
              <div style="font-size: 11px; color: var(--text-secondary); margin-bottom: 2px;">AM</div>
              <div id="schedule-timeline-am" class="schedule-timeline" style="
                position: relative;
                height: 50px;
                background: var(--bg-secondary);
                border: 1px solid var(--border);
                border-radius: 4px;
                cursor: crosshair;
                overflow: hidden;
                user-select: none;
              ">
                <!-- AM hour segments will be added here -->
              </div>
              <div style="position: relative; margin-top: 2px; font-size: 10px; color: var(--text-secondary); height: 15px;">
                <span style="position: absolute; left: 0%; transform: translateX(-50%);">12</span>
                <span style="position: absolute; left: 8.33%; transform: translateX(-50%);">1</span>
                <span style="position: absolute; left: 16.67%; transform: translateX(-50%);">2</span>
                <span style="position: absolute; left: 25%; transform: translateX(-50%);">3</span>
                <span style="position: absolute; left: 33.33%; transform: translateX(-50%);">4</span>
                <span style="position: absolute; left: 41.67%; transform: translateX(-50%);">5</span>
                <span style="position: absolute; left: 50%; transform: translateX(-50%);">6</span>
                <span style="position: absolute; left: 58.33%; transform: translateX(-50%);">7</span>
                <span style="position: absolute; left: 66.67%; transform: translateX(-50%);">8</span>
                <span style="position: absolute; left: 75%; transform: translateX(-50%);">9</span>
                <span style="position: absolute; left: 83.33%; transform: translateX(-50%);">10</span>
                <span style="position: absolute; left: 91.67%; transform: translateX(-50%);">11</span>
              </div>
            </div>
            
            <!-- PM Timeline -->
            <div>
              <div style="font-size: 11px; color: var(--text-secondary); margin-bottom: 2px;">PM</div>
              <div id="schedule-timeline-pm" class="schedule-timeline" style="
                position: relative;
                height: 50px;
                background: var(--bg-secondary);
                border: 1px solid var(--border);
                border-radius: 4px;
                cursor: crosshair;
                overflow: hidden;
                user-select: none;
              ">
                <!-- PM hour segments will be added here -->
              </div>
              <div style="position: relative; margin-top: 2px; font-size: 10px; color: var(--text-secondary); height: 15px;">
                <span style="position: absolute; left: 0%; transform: translateX(-50%);">12</span>
                <span style="position: absolute; left: 8.33%; transform: translateX(-50%);">1</span>
                <span style="position: absolute; left: 16.67%; transform: translateX(-50%);">2</span>
                <span style="position: absolute; left: 25%; transform: translateX(-50%);">3</span>
                <span style="position: absolute; left: 33.33%; transform: translateX(-50%);">4</span>
                <span style="position: absolute; left: 41.67%; transform: translateX(-50%);">5</span>
                <span style="position: absolute; left: 50%; transform: translateX(-50%);">6</span>
                <span style="position: absolute; left: 58.33%; transform: translateX(-50%);">7</span>
                <span style="position: absolute; left: 66.67%; transform: translateX(-50%);">8</span>
                <span style="position: absolute; left: 75%; transform: translateX(-50%);">9</span>
                <span style="position: absolute; left: 83.33%; transform: translateX(-50%);">10</span>
                <span style="position: absolute; left: 91.67%; transform: translateX(-50%);">11</span>
              </div>
            </div>
          </div>
          
          <div style="display: flex; gap: 10px; margin-top: 10px; flex-wrap: wrap;">
            <button class="button" style="font-size: 11px; padding: 4px 8px;" onclick="setAllHours(true)">
              All Active
            </button>
            <button class="button" style="font-size: 11px; padding: 4px 8px;" onclick="setAllHours(false)">
              All Inactive
            </button>
            <button class="button" style="font-size: 11px; padding: 4px 8px;" onclick="setWorkHours()">
              9-5
            </button>
            <button class="button" style="font-size: 11px; padding: 4px 8px;" onclick="setNightHours()">
              Night
            </button>
          </div>
        </div>
        
        <div class="divider"></div>
        
        <details>
          <summary style="cursor: pointer; font-weight: bold; margin-bottom: 10px;">
            ⚡ Conditional Messages
          </summary>
          
          <div style="margin-top: 10px;">
            <h4 style="margin: 10px 0;">Time-Based Messages</h4>
            
            <div class="control-group" style="background: var(--bg-tertiary); padding: 15px; border-radius: 6px; margin-bottom: 10px;">
              <div class="checkbox-group">
                <label>
                  <input type="checkbox" id="morning-enabled" onchange="updateConditionalConfig()">
                  Morning
                </label>
              </div>
              <div id="morning-settings" style="display: none; margin-left: 20px;">
                <div style="display: flex; gap: 10px; align-items: center; margin: 10px 0;">
                  <label style="font-size: 12px;">From</label>
                  <input type="number" id="morning-start" min="0" max="23" value="6" style="width: 50px;">
                  <label style="font-size: 12px;">to</label>
                  <input type="number" id="morning-end" min="0" max="23" value="12" style="width: 50px;">
                </div>
                <textarea id="morning-message" rows="3" style="width: 100%;"></textarea>
              </div>
            </div>
            
            <div class="control-group" style="background: var(--bg-tertiary); padding: 15px; border-radius: 6px; margin-bottom: 10px;">
              <div class="checkbox-group">
                <label>
                  <input type="checkbox" id="afternoon-enabled" onchange="updateConditionalConfig()">
                  Afternoon
                </label>
              </div>
              <div id="afternoon-settings" style="display: none; margin-left: 20px;">
                <div style="display: flex; gap: 10px; align-items: center; margin: 10px 0;">
                  <label style="font-size: 12px;">From</label>
                  <input type="number" id="afternoon-start" min="0" max="23" value="12" style="width: 50px;">
                  <label style="font-size: 12px;">to</label>
                  <input type="number" id="afternoon-end" min="0" max="23" value="18" style="width: 50px;">
                </div>
                <textarea id="afternoon-message" rows="3" style="width: 100%;"></textarea>
              </div>
            </div>
            
            <div class="control-group" style="background: var(--bg-tertiary); padding: 15px; border-radius: 6px; margin-bottom: 10px;">
              <div class="checkbox-group">
                <label>
                  <input type="checkbox" id="evening-enabled" onchange="updateConditionalConfig()">
                  Evening
                </label>
              </div>
              <div id="evening-settings" style="display: none; margin-left: 20px;">
                <div style="display: flex; gap: 10px; align-items: center; margin: 10px 0;">
                  <label style="font-size: 12px;">From</label>
                  <input type="number" id="evening-start" min="0" max="23" value="18" style="width: 50px;">
                  <label style="font-size: 12px;">to</label>
                  <input type="number" id="evening-end" min="0" max="23" value="23" style="width: 50px;">
                </div>
                <textarea id="evening-message" rows="3" style="width: 100%;"></textarea>
              </div>
            </div>
            
            <h4 style="margin: 10px 0;">Context-Based Messages</h4>
            
            <div class="control-group" style="background: var(--bg-tertiary); padding: 15px; border-radius: 6px; margin-bottom: 10px;">
              <div class="checkbox-group">
                <label>
                  <input type="checkbox" id="low-context-enabled" checked onchange="updateConditionalConfig()">
                  Low Context Warning
                </label>
              </div>
              <div id="low-context-settings" style="margin-left: 20px;">
                <label style="font-size: 12px;">Threshold %</label>
                <input type="number" id="low-context-threshold" min="10" max="50" value="30" style="width: 60px;">
                <textarea id="low-context-message" rows="3" style="margin-top: 5px; width: 100%;"></textarea>
                
                <div class="checkbox-group" style="margin-top: 10px;">
                  <label>
                    <input type="checkbox" id="auto-compact-enabled" onchange="updateConditionalConfig()">
                    Enable Auto-Compact (adds instruction for Claude to say "Let's compact!")
                  </label>
                </div>
              </div>
            </div>
            
            <div class="control-group" style="background: var(--bg-tertiary); padding: 15px; border-radius: 6px; margin-bottom: 10px;">
              <div class="checkbox-group">
                <label>
                  <input type="checkbox" id="after-compact-enabled" checked onchange="updateConditionalConfig()">
                  After Compact Message
                </label>
              </div>
              <div id="after-compact-settings" style="margin-left: 20px;">
                <label style="font-size: 12px;">Lines after compact</label>
                <input type="number" id="after-compact-lines" min="10" max="100" value="50" style="width: 60px;">
                <textarea id="after-compact-message" rows="3" style="margin-top: 5px; width: 100%;"></textarea>
              </div>
            </div>
          </div>
        </details>
        
        <div style="color: var(--text-secondary); font-size: 12px; margin-top: 20px; text-align: center;">
          ✨ Settings auto-save as you type
        </div>
        </div>
      </div>
      
      <!-- Log Viewer -->
      <div class="card" id="log-panel">
        <h2>📜 Console Logging</h2>
        
        <!-- Session Selector -->
        <div style="margin-bottom: 15px; display: flex; align-items: center; gap: 15px;">
          <div>
            <label style="margin-right: 10px;">Tmux Session:</label>
            <select id="session-select" onchange="updateSelectedSession()" style="padding: 6px 10px; border-radius: 4px; background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--bg-tertiary);">
              <option value="claude-loop1">claude-loop1 (loading...)</option>
            </select>
            <button id="new-session-btn" style="padding: 6px 12px; background: var(--primary); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">+ New Session</button>
          </div>
          <div id="monitor-status" style="display: flex; align-items: center; gap: 12px; margin-left: 40px;">
            <span style="font-size: 12px; color: var(--text-secondary);">Logging Status:</span>
            <span id="monitor-status-text" style="font-size: 12px; margin-right: 10px;">Checking...</span>
            <button class="compact-button button-success" onclick="controlLogMonitor('start')" style="padding: 4px 8px; font-size: 11px;">
              📝 Start
            </button>
            <button class="compact-button button-danger" onclick="controlLogMonitor('stop')" style="padding: 4px 8px; font-size: 11px;">
              🛑 Stop
            </button>
          </div>
        </div>
        
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
          <div style="display: flex; align-items: center; gap: 15px;">
            <div>
              <label style="margin-right: 10px;">Show last:</label>
              <select id="log-lines-select" onchange="updateLogLines()" style="padding: 4px 8px; border-radius: 4px; background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--bg-tertiary);">
                <option value="100">100 lines</option>
                <option value="500">500 lines</option>
                <option value="1000">1000 lines</option>
                <option value="5000" selected>5000 lines</option>
                <option value="0">Entire file</option>
              </select>
            </div>
            <label style="display: flex; align-items: center; gap: 5px; font-size: 12px; cursor: pointer;">
              <input type="checkbox" id="enable-lazy-loading" onchange="toggleLazyLoading()" style="cursor: pointer;">
              Lazy Loading
            </label>
          </div>
          <div style="font-size: 12px; color: var(--text-secondary);">
            <span id="log-info">-</span>
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
            id="custom-message" 
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
      
      <!-- Usage Limit Status (moved from Status & Control) -->
      <div id="usage-limit-status" style="display: none; margin-bottom: 15px; padding: 15px; background: var(--warning); color: #000; border-radius: 8px;">
        <div style="font-weight: bold; margin-bottom: 5px;">⚠️ Usage Limit Reached</div>
        <div>Will auto-resume at: <span id="resume-time">-</span></div>
        <div style="font-size: 12px; margin-top: 5px;">
          Auto-resume monitor: <span id="auto-resume-status">checking...</span>
          <button id="start-auto-resume-btn" class="button" style="display: none; margin-left: 10px; padding: 2px 8px; font-size: 11px;" onclick="startAutoResumeMonitor()">
            Start Monitor
          </button>
        </div>
      </div>
    </div>
  </div>
  
  <script>
    let statusInterval;
    let logInterval;
    let currentConfig = {};
    let scheduleMinutes = new Array(1440).fill(true); // Track schedule state at minute level
    
    // Global variables for session management
    let currentSession = 'claude-loop1';
    let availableSessions = [];
    let isMonitorRunning = false;
    let lastCompactTime = 0; // Track when we last sent a compact command
    let currentLogRefreshRate = 10; // Default 10 seconds
    
    // Global functions that need to be accessible from HTML
    
    // Find the next available claude-loop session number
    function getNextAvailableSessionName() {
      const existingNumbers = availableSessions
        .filter(s => s.startsWith('claude-loop'))
        .map(s => {
          const match = s.match(/claude-loop(\\d+)/);
          return match ? parseInt(match[1]) : 0;
        })
        .filter(n => n > 0);
      
      // Find the lowest available number
      let nextNumber = 1;
      while (existingNumbers.includes(nextNumber)) {
        nextNumber++;
      }
      
      return 'claude-loop' + nextNumber;
    }
    
    // Create a new tmux session
    async function createNewSession() {
      try {
        const newSessionName = getNextAvailableSessionName();
        console.log('Creating new session:', newSessionName);
        
        // Create the tmux session
        const response = await fetch('/api/tmux-setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            session: newSessionName, 
            action: 'create' 
          })
        });
        
        if (!response.ok) {
          throw new Error('Failed to create session');
        }
        
        // Show success message immediately
        const logsEl = document.getElementById('logs');
        if (logsEl) {
          logsEl.innerHTML = '<span style="color: var(--success);">✅ Creating session: ' + newSessionName + '...</span>';
        }
        
        // Reload the page after a short delay to show the new session
        setTimeout(() => {
          window.location.reload();
        }, 1500);
        
      } catch (error) {
        console.error('Failed to create new session:', error);
        alert('Failed to create new session: ' + error.message);
      }
    }
    
    // Update selected session
    async function updateSelectedSession() {
      const select = document.getElementById('session-select');
      currentSession = select.value;
      
      // Update page title
      document.title = 'Claude Loop Dashboard - ' + currentSession;
      
      // Update the display to reflect the new session
      updateMonitorStatus();
      updateLogs();
    }
    
    // Forward declarations for functions defined later
    let loadTmuxSessions, updateMonitorStatus, updateLogs, controlLogMonitor;
    
    // ANSI to HTML converter - USE THE OLD WORKING VERSION
    function convertAnsiToHtml(line) {
      return convertAnsiToHtmlOld(line);
    }
    
    function processAnsiCode(code) {
      // Handle different ANSI codes
      if (code === '0' || code === '') {
        // Reset all
        return '</span><span>';
      } else if (code === '39' || code === '49') {
        // Reset color
        return '</span><span>';
      } else if (code.startsWith('38;2;')) {
        // 24-bit foreground color
        const rgb = code.split(';').slice(2);
        if (rgb.length === 3) {
          return '</span><span style="color: rgb(' + rgb.join(',') + ');">';
        }
      } else if (code.startsWith('48;2;')) {
        // 24-bit background color
        const rgb = code.split(';').slice(2);
        if (rgb.length === 3) {
          return '</span><span style="background-color: rgb(' + rgb.join(',') + ');">';
        }
      } else {
        // Simple codes
        const styleMap = {
          // Text styles
          '1': 'font-weight: bold;',
          '2': 'opacity: 0.7;',
          '3': 'font-style: italic;',
          '4': 'text-decoration: underline;',
          '7': 'filter: invert(100%);',
          '9': 'text-decoration: line-through;',
          // Standard colors
          '30': 'color: #000000;',
          '31': 'color: #cc0000;',
          '32': 'color: #4e9a06;',
          '33': 'color: #c4a000;',
          '34': 'color: #3465a4;',
          '35': 'color: #75507b;',
          '36': 'color: #06989a;',
          '37': 'color: #d3d7cf;',
          // Bright colors
          '90': 'color: #555753;',
          '91': 'color: #ef2929;',
          '92': 'color: #8ae234;',
          '93': 'color: #fce94f;',
          '94': 'color: #729fcf;',
          '95': 'color: #ad7fa8;',
          '96': 'color: #34e2e2;',
          '97': 'color: #eeeeec;'
        };
        
        if (styleMap[code]) {
          return '</span><span style="' + styleMap[code] + '">';
        }
      }
      return ''; // Remove unrecognized codes
    }
    
    // OLD COMPLEX VERSION (preserved for reference)
    function convertAnsiToHtmlOld(line) {
      // First escape HTML to prevent XSS
      let processed = line
        .split('&').join('&amp;')
        .split('<').join('&lt;')
        .split('>').join('&gt;')
        .split('"').join('&quot;')
        .split("'").join('&#x27;');
      
      // Convert ANSI codes to HTML - handle all the patterns
      let result = '';
      let openSpans = [];
      let i = 0;
      
      while (i < processed.length) {
        // Look for ESC character (in template literal, \x1b becomes actual ESC)
        if (processed.charCodeAt(i) === 27 && processed[i+1] === '[') {
          // Find the end of the ANSI code
          let codeEnd = i + 2;
          while (codeEnd < processed.length && processed[codeEnd] !== 'm') {
            codeEnd++;
          }
          
          if (codeEnd < processed.length) {
            const code = processed.substring(i + 2, codeEnd);
            
            // Handle different ANSI codes
            if (code === '0' || code === '') {
              // Reset all
              while (openSpans.length > 0) {
                result += '</span>';
                openSpans.pop();
              }
            } else if (code === '39' || code === '49') {
              // Reset foreground/background color only
              if (openSpans.length > 0) {
                result += '</span>';
                openSpans.pop();
              }
            } else if (code.startsWith('38;2;')) {
              // 24-bit foreground color
              const rgb = code.split(';').slice(2);
              if (rgb.length === 3) {
                // Close previous color span if any
                if (openSpans.length > 0 && openSpans[openSpans.length - 1].includes('color:')) {
                  result += '</span>';
                  openSpans.pop();
                }
                result += '<span style="color: rgb(' + rgb.join(',') + ');">';
                openSpans.push('color');
              }
            } else if (code.startsWith('48;2;')) {
              // 24-bit background color
              const rgb = code.split(';').slice(2);
              if (rgb.length === 3) {
                result += '<span style="background-color: rgb(' + rgb.join(',') + ');">';
                openSpans.push('bgcolor');
              }
            } else {
              // Simple codes
              const styleMap = {
                // Text styles
                '1': 'font-weight: bold;',
                '2': 'opacity: 0.7;',
                '3': 'font-style: italic;',
                '4': 'text-decoration: underline;',
                '7': 'filter: invert(100%);',
                '9': 'text-decoration: line-through;',
                // Standard colors
                '30': 'color: #000000;',
                '31': 'color: #cc0000;',
                '32': 'color: #4e9a06;',
                '33': 'color: #c4a000;',
                '34': 'color: #3465a4;',
                '35': 'color: #75507b;',
                '36': 'color: #06989a;',
                '37': 'color: #d3d7cf;',
                // Bright colors
                '90': 'color: #555753;',
                '91': 'color: #ef2929;',
                '92': 'color: #8ae234;',
                '93': 'color: #fce94f;',
                '94': 'color: #729fcf;',
                '95': 'color: #ad7fa8;',
                '96': 'color: #34e2e2;',
                '97': 'color: #eeeeec;'
              };
              
              if (styleMap[code]) {
                // For color codes, close previous color
                if (code >= '30' && code <= '97' && openSpans.length > 0) {
                  const lastSpan = openSpans[openSpans.length - 1];
                  if (lastSpan === 'color' || (parseInt(code) >= 30 && parseInt(code) <= 97)) {
                    result += '</span>';
                    openSpans.pop();
                  }
                }
                result += '<span style="' + styleMap[code] + '">';
                openSpans.push(code >= '30' ? 'color' : 'style');
              }
            }
            
            i = codeEnd + 1;
            continue;
          }
        }
        
        // Regular character
        result += processed[i];
        i++;
      }
      
      // Close any remaining open spans
      while (openSpans.length > 0) {
        result += '</span>';
        openSpans.pop();
      }
      
      return result;
    }
    
    // Control log monitor separately
    controlLogMonitor = async function(action) {
      try {
        const payload = { 
          action, 
          instance: currentSession || 'claude-loop1',  // Use session name as instance
          session: currentSession || 'claude-loop1'
        };
        
        const response = await fetch('/api/log-monitor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        
        if (!response.ok) {
          const result = await response.json();
          if (result.message && result.message.includes('ERROR:')) {
            alert(result.message);
            return;
          }
        }
        
        setTimeout(() => {
          updateMonitorStatus();
          updateLogs();
        }, 500);
      } catch (error) {
        console.error('Log monitor control error:', error);
        alert('Failed to control log monitor: ' + error.message);
      }
    }

    // Control loop function - needs to be global for onclick handlers
    async function controlLoop(action) {
      try {
        // If starting, ensure tmux session exists first
        if (action === 'start') {
          const tmuxResponse = await fetch('/api/tmux-setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session: 'claude-chat', action: 'ensure' })
          });
          
          if (!tmuxResponse.ok) {
            console.error('Failed to ensure tmux session');
            return;
          }
          
          // Small delay to ensure tmux is ready
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        
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
    
    
    // Update log monitor status
    async function updateLogMonitorStatus() {
      try {
        const response = await fetch('/api/log-monitor/status');
        const data = await response.json();
        
        const statusDot = document.querySelector('#log-monitor-status .status-dot');
        const statusText = document.getElementById('log-monitor-text');
        
        if (statusDot && statusText) {
          if (data.running) {
            statusDot.style.background = 'var(--success)';
            statusText.textContent = 'Running (PID: ' + data.pid + ')';
          } else {
            statusDot.style.background = 'var(--danger)';
            statusText.textContent = 'Stopped';
          }
        }
      } catch (error) {
        console.error('Failed to update log monitor status:', error);
      }
    }
    
    // Open Claude session (creates tmux and opens browser/IDE)
    async function openClaudeSession() {
      try {
        const response = await fetch('/api/tmux-setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session: 'claude-chat', action: 'create' })
        });
        
        if (response.ok) {
          const result = await response.json();
          console.log('Claude session setup:', result.message);
          
          // Show temporary success message
          const btn = event.target;
          const originalText = btn.textContent;
          btn.textContent = '✅ Opening...';
          setTimeout(() => {
            btn.textContent = originalText;
          }, 2000);
        }
      } catch (error) {
        console.error('Failed to open Claude session:', error);
        alert('Failed to open Claude session: ' + error.message);
      }
    }
    
    // Helper to safely set element values
    function setElementValue(id, value, property = 'value') {
      const element = document.getElementById(id);
      if (element) {
        element[property] = value;
      } else {
        console.warn(\`Element not found: \${id}\`);
      }
    }
    
    // Helper to safely get element values
    function getElementValue(id, property = 'value', defaultValue = '') {
      const element = document.getElementById(id);
      if (element) {
        return element[property];
      }
      return defaultValue;
    }
    
    async function loadConfig() {
      try {
        const response = await fetch('/api/config');
        currentConfig = await response.json();
        
        // Update UI with config
        setElementValue('delay-minutes', currentConfig.delayMinutes);
        setElementValue('context-aware', currentConfig.contextAware, 'checked');
        setElementValue('context-warning', currentConfig.contextWarningPercent);
        setElementValue('context-critical', currentConfig.contextCriticalPercent);
        setElementValue('use-start-time', currentConfig.useStartTime, 'checked');
        setElementValue('start-time', currentConfig.startTime);
        setElementValue('custom-message', currentConfig.customMessage);
        setElementValue('enable-log-rotation', currentConfig.enableLogRotation !== false, 'checked');
        setElementValue('max-log-size', (currentConfig.maxLogSize / (1024 * 1024)) || 1);
        setElementValue('log-refresh-rate', currentConfig.logRefreshRate || 10);
        currentLogRefreshRate = currentConfig.logRefreshRate || 10;
        
        // Update conditional messages
        if (currentConfig.conditionalMessages) {
          const cm = currentConfig.conditionalMessages;
          
          // Time-based
          setElementValue('morning-enabled', cm.morningMessage?.enabled || false, 'checked');
          setElementValue('morning-start', cm.morningMessage?.startHour || 6);
          setElementValue('morning-end', cm.morningMessage?.endHour || 12);
          setElementValue('morning-message', cm.morningMessage?.message || '');
          setElementValue('afternoon-enabled', cm.afternoonMessage?.enabled || false, 'checked');
          setElementValue('afternoon-start', cm.afternoonMessage?.startHour || 12);
          setElementValue('afternoon-end', cm.afternoonMessage?.endHour || 18);
          setElementValue('afternoon-message', cm.afternoonMessage?.message || '');
          setElementValue('evening-enabled', cm.eveningMessage?.enabled || false, 'checked');
          setElementValue('evening-start', cm.eveningMessage?.startHour || 18);
          setElementValue('evening-end', cm.eveningMessage?.endHour || 23);
          setElementValue('evening-message', cm.eveningMessage?.message || '');
          
          // Context-based
          setElementValue('low-context-enabled', cm.lowContextMessage?.enabled || false, 'checked');
          setElementValue('low-context-threshold', cm.lowContextMessage?.threshold || 30);
          setElementValue('low-context-message', cm.lowContextMessage?.message || 'Please prepare to wrap up current work and create a summary. Context is getting low.');
          setElementValue('auto-compact-enabled', cm.lowContextMessage?.autoCompact || false, 'checked');
          setElementValue('after-compact-enabled', cm.afterCompactMessage?.enabled || false, 'checked');
          setElementValue('after-compact-lines', cm.afterCompactMessage?.linesAfterCompact || 50);
          setElementValue('after-compact-message', cm.afterCompactMessage?.message || '');
        }
        
        // Update schedule if present
        if (currentConfig.schedule) {
          setElementValue('schedule-enabled', currentConfig.schedule.enabled || false, 'checked');
          if (currentConfig.schedule.minutes) {
            scheduleMinutes = [...currentConfig.schedule.minutes]; // Make a copy to avoid reference issues
          } else if (currentConfig.schedule.hours) {
            // Migrate from old hour-based format
            for (let hour = 0; hour < 24; hour++) {
              const isActive = currentConfig.schedule.hours[hour];
              for (let min = hour * 60; min < (hour + 1) * 60; min++) {
                scheduleMinutes[min] = isActive;
              }
            }
          }
          if (currentConfig.schedule.precision) {
            setElementValue('schedule-precision', currentConfig.schedule.precision);
          }
          // Delay to ensure DOM is ready
          setTimeout(() => {
            updateScheduleSettings(); // Initialize the timeline if enabled
          }, 100);
        }
        
        // Toggle visibility
        updateContextSettings();
        updateStartTimeSettings();
        // updateScheduleSettings(); // Already called above with delay
        updateConditionalConfig();
        updateLogRotationConfig();
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
        useStartTime: getElementValue('use-start-time', 'checked', false),
        startTime: getElementValue('start-time', 'value', '09:00'),
        customMessage: getElementValue('custom-message', 'value', 'Please continue'),
        enableLogRotation: getElementValue('enable-log-rotation', 'checked', true),
        maxLogSize: parseFloat(getElementValue('max-log-size', 'value', '1')) * 1024 * 1024,
        logRefreshRate: parseInt(getElementValue('log-refresh-rate', 'value', '10')),
        conditionalMessages: {
          morningMessage: {
            enabled: getElementValue('morning-enabled', 'checked', false),
            startHour: parseInt(getElementValue('morning-start', 'value', '6')),
            endHour: parseInt(getElementValue('morning-end', 'value', '12')),
            message: getElementValue('morning-message', 'value', '')
          },
          afternoonMessage: {
            enabled: getElementValue('afternoon-enabled', 'checked', false),
            startHour: parseInt(getElementValue('afternoon-start', 'value', '12')),
            endHour: parseInt(getElementValue('afternoon-end', 'value', '18')),
            message: getElementValue('afternoon-message', 'value', '')
          },
          eveningMessage: {
            enabled: getElementValue('evening-enabled', 'checked', false),
            startHour: parseInt(getElementValue('evening-start', 'value', '18')),
            endHour: parseInt(getElementValue('evening-end', 'value', '23')),
            message: getElementValue('evening-message', 'value', '')
          },
          lowContextMessage: {
            enabled: getElementValue('low-context-enabled', 'checked', false),
            threshold: parseInt(getElementValue('low-context-threshold', 'value', '30')),
            message: getElementValue('low-context-message', 'value', ''),
            autoCompact: getElementValue('auto-compact-enabled', 'checked', false)
          },
          afterCompactMessage: {
            enabled: getElementValue('after-compact-enabled', 'checked', false),
            linesAfterCompact: parseInt(getElementValue('after-compact-lines', 'value', '50')),
            message: getElementValue('after-compact-message', 'value', '')
          }
        },
        schedule: {
          enabled: getElementValue('schedule-enabled', 'checked', false),
          minutes: scheduleMinutes,
          precision: parseInt(getElementValue('schedule-precision', 'value', '15')),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
        }
      };
      
      try {
        const response = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config)
        });
        
        if (!response.ok) {
          throw new Error(\`HTTP error! status: \${response.status}\`);
        }
        
        console.log('Config saved successfully');
      } catch (error) {
        console.error('Failed to save config:', error);
        alert('Failed to save settings: ' + error.message);
      }
    }
    
    async function checkUsageLimit() {
      try {
        // Check if pause file exists and has resume time
        const pauseResponse = await fetch('/api/pause-status');
        const pauseStatus = await pauseResponse.json();
        
        const usageLimitDiv = document.getElementById('usage-limit-status');
        const resumeTimeSpan = document.getElementById('resume-time');
        const autoResumeSpan = document.getElementById('auto-resume-status');
        
        if (pauseStatus.paused && pauseStatus.resumeTime) {
          // Show usage limit status
          usageLimitDiv.style.display = 'block';
          
          const resumeDate = new Date(pauseStatus.resumeTime);
          const now = new Date();
          
          resumeTimeSpan.textContent = resumeDate.toLocaleTimeString([], { 
            hour: '2-digit', 
            minute: '2-digit' 
          });
          
          // Check if auto-resume is running
          const autoResumeResponse = await fetch('/api/auto-resume-status');
          const autoResumeRunning = autoResumeResponse.ok && (await autoResumeResponse.json()).running;
          
          if (autoResumeRunning) {
            if (now >= resumeDate) {
              autoResumeSpan.textContent = 'resuming...';
              autoResumeSpan.style.color = 'green';
            } else {
              const timeLeft = resumeDate - now;
              const hours = Math.floor(timeLeft / 3600000);
              const minutes = Math.floor((timeLeft % 3600000) / 60000);
              autoResumeSpan.textContent = \`active (\${hours}h \${minutes}m remaining)\`;
              autoResumeSpan.style.color = 'green';
            }
          } else {
            autoResumeSpan.textContent = 'not running';
            autoResumeSpan.style.color = 'red';
            // Show start button
            document.getElementById('start-auto-resume-btn').style.display = 'inline-block';
          }
        } else {
          // Hide usage limit status
          usageLimitDiv.style.display = 'none';
        }
      } catch (error) {
        console.error('Failed to check usage limit:', error);
      }
    }
    
    async function updateStatus() {
      try {
        const response = await fetch('/api/status');
        const status = await response.json();
        
        const indicator = document.getElementById('status-indicator');
        const text = document.getElementById('status-text');
        const pidInfo = document.getElementById('pid-info');
        
        let statusClass, statusText;
        
        if (status.running) {
          if (status.paused) {
            statusClass = 'status-indicator paused';
            statusText = 'Loop is paused';
          } else {
            statusClass = 'status-indicator running';
            statusText = 'Loop is running';
          }
          pidInfo.textContent = 'PID: ' + status.pid;
        } else {
          statusClass = 'status-indicator stopped';
          statusText = 'Loop is stopped';
          pidInfo.textContent = '';
        }
        
        // Update status indicator and text
        indicator.className = statusClass;
        text.textContent = statusText;
        
        // Update button states
        const buttons = [
          { id: 'horizontal-start-btn', disabled: status.running },
          { id: 'horizontal-stop-btn', disabled: !status.running },
          { id: 'horizontal-pause-btn', disabled: !status.running || status.paused },
          { id: 'horizontal-resume-btn', disabled: !status.running || !status.paused }
        ];
        
        buttons.forEach(btn => {
          const element = document.getElementById(btn.id);
          if (element) element.disabled = btn.disabled;
        });
        
        // Check for usage limit
        await checkUsageLimit();
        
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
        
        // Update horizontal elements
        const compactFill = document.getElementById('compact-context-fill');
        const horizontalLastUpdated = document.getElementById('horizontal-last-updated');
        const horizontalLogSize = document.getElementById('horizontal-log-size');
        const horizontalLinesSince = document.getElementById('horizontal-lines-since-compact');
        
        const percent = context.contextPercent || 100;
        const lastUpdated = new Date(context.timestamp).toLocaleTimeString([], { 
          hour: '2-digit', 
          minute: '2-digit' 
        });
        const logSizeText = context.logSize ? (context.logSize / 1024).toFixed(1) + ' KB' : '-';
        const linesSinceText = context.lastCompact || 'No compact';
        
        // Update original context meter (if exists)
        if (fill) {
          fill.style.width = percent + '%';
          fill.textContent = percent + '%';
          
          // Update color based on percentage
          fill.className = 'context-fill';
          if (percent <= currentConfig.contextCriticalPercent) {
            fill.classList.add('context-critical');
          } else if (percent <= currentConfig.contextWarningPercent) {
            fill.classList.add('context-warning');
          }
        }
        
        // Update compact horizontal context meter
        if (compactFill) {
          compactFill.style.width = percent + '%';
          compactFill.textContent = percent + '%';
          
          compactFill.className = 'compact-context-fill';
          if (percent <= currentConfig.contextCriticalPercent) {
            compactFill.classList.add('context-critical');
          } else if (percent <= currentConfig.contextWarningPercent) {
            compactFill.classList.add('context-warning');
          }
        }
        
        // Update original elements (if they exist)
        if (info) info.textContent = 'Last updated: ' + lastUpdated;
        if (logSize) logSize.textContent = logSizeText;
        if (linesSince) linesSince.textContent = linesSinceText;
        
        // Update horizontal stats
        if (horizontalLastUpdated) horizontalLastUpdated.textContent = lastUpdated;
        if (horizontalLogSize) horizontalLogSize.textContent = logSizeText;
        if (horizontalLinesSince) horizontalLinesSince.textContent = linesSinceText;
        
      } catch (error) {
        console.error('Failed to update context:', error);
      }
    }
    
    let currentLogLines = 1000; // Default - reduced for performance
    let allLogLines = []; // Store all lines for virtual scrolling
    let lastLogHash = ''; // Track changes to avoid unnecessary re-renders
    let lazyLoadingEnabled = false; // Default to off since it works better
    
    // Load available tmux sessions
    loadTmuxSessions = async function() {
      try {
        const response = await fetch('/api/tmux-sessions');
        const data = await response.json();
        const select = document.getElementById('session-select');
        
        // Update available sessions list - only include claude-loop* sessions
        const allSessions = data.sessions || [];
        availableSessions = allSessions.filter(s => s.startsWith('claude-loop'));
        
        // Clear existing options
        select.innerHTML = '';
        
        // Sort claude-loop sessions by number
        const claudeLoopSessions = availableSessions
          .sort((a, b) => {
            const matchA = a.match(/claude-loop(\\d+)/);
            const matchB = b.match(/claude-loop(\\d+)/);
            const numA = parseInt(matchA ? matchA[1] : '0');
            const numB = parseInt(matchB ? matchB[1] : '0');
            return numA - numB;
          });
        
        // Add claude-loop sessions
        claudeLoopSessions.forEach(session => {
          const option = document.createElement('option');
          option.value = session;
          option.textContent = session;
          select.appendChild(option);
        });
        
        // If no sessions exist, create the first one
        if (select.options.length === 0) {
          currentSession = 'claude-loop1';
          const option = document.createElement('option');
          option.value = currentSession;
          option.textContent = currentSession + ' (new)';
          select.appendChild(option);
        } else if (!currentSession || !availableSessions.includes(currentSession)) {
          // Set current session to first available
          currentSession = select.options[0].value;
        }
        
        // Select the current session
        select.value = currentSession;
        
        // Update page title
        document.title = 'Claude Loop Dashboard - ' + currentSession;
        
        // Update monitor status
        updateMonitorStatus();
      } catch (error) {
        console.error('Failed to load tmux sessions:', error);
      }
    }
    
    // Update selected session
    async function updateSelectedSession() {
      const select = document.getElementById('session-select');
      currentSession = select.value;
      
      // Update page title
      document.title = 'Claude Loop Dashboard - ' + currentSession;
      
      // Don't automatically restart monitor - let user control it
      // Just update the display to reflect the new session
      updateMonitorStatus();
      updateLogs();
    }
    
    // Update monitor status indicator
    updateMonitorStatus = async function() {
      try {
        const instance = currentSession || 'claude-loop1';
        const response = await fetch(\`/api/log-monitor/status?instance=\${encodeURIComponent(instance)}\`);
        const data = await response.json();
        const statusText = document.getElementById('monitor-status-text');
        
        if (data.running) {
          statusText.innerHTML = \`<span style="color: var(--success);">✓ Capturing \${instance}</span>\`;
          isMonitorRunning = true;
        } else {
          statusText.innerHTML = '<span style="color: var(--danger);">✗ Not running</span>';
          isMonitorRunning = false;
        }
      } catch (error) {
        console.error('Failed to check monitor status:', error);
        const statusText = document.getElementById('monitor-status-text');
        statusText.innerHTML = '<span style="color: var(--warning);">? Unknown</span>';
      }
    }
    
    function updateLogLines() {
      const select = document.getElementById('log-lines-select');
      currentLogLines = parseInt(select.value);
      updateLogs();
    }
    
    function toggleLazyLoading() {
      const checkbox = document.getElementById('enable-lazy-loading');
      lazyLoadingEnabled = checkbox.checked;
      console.log('Lazy loading:', lazyLoadingEnabled ? 'enabled' : 'disabled');
      updateLogs(); // Re-render with new setting
    }
    
    function scrollLogsToBottom() {
      const logsEl = document.getElementById('logs');
      logsEl.scrollTop = logsEl.scrollHeight;
    }
    
    updateLogs = async function(isScrollUpdate = false) {
      // Skip scroll updates if lazy loading is disabled
      if (isScrollUpdate && !lazyLoadingEnabled) {
        return;
      }
      
      // Only update logs if monitor is running
      if (!isMonitorRunning && !isScrollUpdate) {
        const logsEl = document.getElementById('logs');
        logsEl.innerHTML = '<span style="color: var(--text-secondary);">No active monitor - Click "Start Console Logging" to begin</span>';
        return;
      }
      
      // Only log non-scroll updates to reduce console noise
      if (!isScrollUpdate) {
        console.log('[Log Update] Auto-refresh at', new Date().toLocaleTimeString());
      }
      try {
        const response = await fetch(\`/api/logs?maxLines=\${currentLogLines}&session=\${currentSession}\`);
        const data = await response.json();
        
        // Debug: Check what we're getting from the API
        if (!isScrollUpdate && data.logs && data.logs.includes('\\x1b[')) {
          console.log('Raw log sample (first 200 chars):', data.logs.substring(0, 200));
        }
        
        const logsEl = document.getElementById('logs');
        
        if (!data.logs || data.logs.trim() === '') {
          logsEl.innerHTML = '<span style="color: var(--text-secondary);">No logs available</span>';
          return;
        }
        
        // Check if logs have changed
        const currentHash = data.logs.substring(0, 100) + data.logs.length;
        if (currentHash === lastLogHash && allLogLines.length > 0) {
          return; // No changes, skip update
        }
        lastLogHash = currentHash;
        
        // Check if user is at the bottom before updating
        const wasAtBottom = (logsEl.scrollTop + logsEl.clientHeight) >= (logsEl.scrollHeight - 10);
        
        // Format logs with proper line breaks and styling
        const lines = data.logs.split('\\n');
        allLogLines = lines; // Store for virtual scrolling
        
        // If lazy loading is disabled, always render all lines
        if (!lazyLoadingEnabled) {
          const formattedLines = lines.map(line => {
            let escaped = convertAnsiToHtml(line);
            return escaped;
          });
          
          logsEl.innerHTML = formattedLines.join('<br>');
          
          // Only auto-scroll if user was already at the bottom
          if (wasAtBottom) {
            logsEl.scrollTop = logsEl.scrollHeight;
          }
          
          // Update log info
          const logInfo = document.getElementById('log-info');
          if (logInfo) {
            const lineCount = lines.length;
            const sizeKB = (data.logs.length / 1024).toFixed(1);
            logInfo.textContent = \`\${lineCount} lines, \${sizeKB} KB\`;
          }
          
          return; // Exit early, no virtual scrolling
        }
        
        // For initial load or small logs with lazy loading enabled
        if (lines.length < 100 || !logsEl.hasAttribute('data-initialized')) {
          // Simple rendering for initial load
          const formattedLines = lines.map(line => {
            // Use our shared ANSI converter for consistent colors
            let escaped = convertAnsiToHtml(line);
            
            // OLD METHOD (preserved but commented out):
            // Basic ANSI to HTML conversion using regex
            // escaped = escaped.replace(/\\x1b\\[(\\d+)m/g, (match, code) => {
            //   const colorMap = {
            //     '31': '</span><span style="color: #cc0000;">',
            //     '32': '</span><span style="color: #4e9a06;">',
            //     '33': '</span><span style="color: #c4a000;">',
            //     '34': '</span><span style="color: #3465a4;">',
            //     '35': '</span><span style="color: #75507b;">',
            //     '36': '</span><span style="color: #06989a;">',
            //     '0': '</span><span>'
            //   };
            //   return colorMap[code] || '';
            // });
            
            return escaped;
          });
          
          logsEl.innerHTML = formattedLines.join('<br>');
          logsEl.setAttribute('data-initialized', 'true');
          
          // Auto-scroll to bottom on initial load
          if (!logsEl.hasAttribute('data-user-scrolled')) {
            logsEl.scrollTop = logsEl.scrollHeight;
          }
          return;
        }
        
        // Virtual scrolling for large logs
        const lineHeight = 20; // Approximate line height in pixels
        const containerHeight = logsEl.clientHeight || 600;
        const scrollTop = logsEl.scrollTop || 0;
        const totalHeight = lines.length * lineHeight;
        
        // Calculate which lines are visible with larger buffer for smoother scrolling
        const visibleStart = Math.max(0, Math.floor(scrollTop / lineHeight) - 50);
        const visibleEnd = Math.min(lines.length, Math.ceil((scrollTop + containerHeight) / lineHeight) + 50);
        
        // Only process visible lines for performance
        const visibleLines = lines.slice(visibleStart, visibleEnd);
        const formattedLines = visibleLines.map((line, index) => {
          const actualIndex = visibleStart + index;
          // Use our shared ANSI converter for consistent colors
          let escaped = convertAnsiToHtml(line);
          
          // Add color coding for different types of lines
          if (line.includes('[ERROR]') || line.includes('error:')) {
            return \`<span style="color: var(--danger);">\${escaped}</span>\`;
          } else if (line.includes('[WARNING]') || line.includes('⚠️')) {
            return \`<span style="color: var(--warning);">\${escaped}</span>\`;
          } else if (line.includes('[SUCCESS]') || line.includes('✅')) {
            return \`<span style="color: var(--success);">\${escaped}</span>\`;
          } else if (line.includes('[INFO]') || line.includes('ℹ️')) {
            return \`<span style="color: var(--accent);">\${escaped}</span>\`;
          } else if (line.startsWith('Human:') || line.startsWith('Assistant:')) {
            return \`<span style="color: var(--accent); font-weight: bold;">\${escaped}</span>\`;
          } else if (line.includes('\`\`\`')) {
            return \`<span style="color: var(--text-secondary); font-family: monospace;">\${escaped}</span>\`;
          }
          
          return escaped;
        });
        
        // Create virtual scrolling container
        const html = \`
          <div style="height: \${visibleStart * lineHeight}px;"></div>
          \${formattedLines.join('<br>')}
          <div style="height: \${(lines.length - visibleEnd) * lineHeight}px;"></div>
        \`;
        
        logsEl.innerHTML = html;
        
        // Restore scroll position
        logsEl.scrollTop = scrollTop;
        
        // Only auto-scroll if user was already at the bottom
        if (wasAtBottom) {
          logsEl.scrollTop = logsEl.scrollHeight;
        }
        
        // Update log info
        const logInfo = document.getElementById('log-info');
        if (logInfo) {
          const lineCount = lines.length;
          const sizeKB = (data.logs.length / 1024).toFixed(1);
          logInfo.textContent = \`\${lineCount} lines, \${sizeKB} KB\`;
        }
        
        // Check for auto-compact trigger phrase
        if (currentConfig.conditionalMessages?.lowContextMessage?.autoCompact) {
          const lastFewLines = lines.slice(-10).join('\\n');
          if (lastFewLines.includes("Let's compact!")) {
            console.log('Auto-compact trigger detected!');
            // Send /compact command
            await sendCompactCommand();
          }
        }
      } catch (error) {
        console.error('Failed to update logs:', error);
      }
    }
    
    async function sendCompactCommand() {
      // Prevent sending multiple compact commands too quickly
      const now = Date.now();
      if (now - lastCompactTime < 60000) { // Wait at least 1 minute between compacts
        console.log('Skipping compact - too soon since last compact');
        return;
      }
      
      try {
        lastCompactTime = now;
        console.log('Sending /compact command to tmux...');
        const response = await fetch('/api/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'send-message', message: '/compact', session: currentSession })
        });
        
        if (response.ok) {
          console.log('✅ Compact command sent successfully');
          // Show a notification on the dashboard
          const statusText = document.getElementById('status-text');
          const originalText = statusText.textContent;
          statusText.textContent = '✅ Auto-compact triggered!';
          setTimeout(() => {
            statusText.textContent = originalText;
          }, 3000);
        } else {
          console.error('Failed to send compact command');
        }
      } catch (error) {
        console.error('Error sending compact command:', error);
      }
    }
    
    async function startAutoResumeMonitor() {
      try {
        const btn = document.getElementById('start-auto-resume-btn');
        btn.disabled = true;
        btn.textContent = 'Starting...';
        
        const response = await fetch('/api/start-auto-resume', { method: 'POST' });
        if (response.ok) {
          btn.style.display = 'none';
          document.getElementById('auto-resume-status').textContent = 'starting...';
          
          // Check status again in a few seconds
          setTimeout(() => {
            checkUsageLimit();
          }, 3000);
        } else {
          throw new Error('Failed to start monitor');
        }
      } catch (error) {
        alert('Failed to start auto-resume monitor: ' + error.message);
        const btn = document.getElementById('start-auto-resume-btn');
        btn.disabled = false;
        btn.textContent = 'Start Monitor';
      }
    }
    
    async function sendMessage() {
      const messageInput = document.getElementById('custom-message');
      const message = messageInput.value.trim();
      if (!message) return;
      
      try {
        const response = await fetch('/api/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'send-message', message, session: currentSession })
        });
        
        if (response.ok) {
          // Clear the input field
          messageInput.value = '';
          
          // Show feedback in status text temporarily
          const statusText = document.getElementById('status-text');
          const originalText = statusText.textContent;
          statusText.textContent = '✅ Message sent!';
          setTimeout(() => {
            statusText.textContent = originalText;
          }, 2000);
          
          // Focus back on input for quick follow-up messages
          messageInput.focus();
        } else {
          throw new Error('Failed to send message');
        }
      } catch (error) {
        console.error('Send message error:', error);
        alert('Failed to send message: ' + error.message);
      }
    }
    
    function updateContextSettings() {
      const enabled = document.getElementById('context-aware').checked;
      document.getElementById('context-settings').style.display = enabled ? 'block' : 'none';
    }
    
    function updateStartTimeSettings() {
      const enabled = document.getElementById('use-start-time').checked;
      document.getElementById('start-time-settings').style.display = enabled ? 'block' : 'none';
    }
    
    function updateLogRotationConfig() {
      const enabled = document.getElementById('enable-log-rotation').checked;
      const settings = document.getElementById('log-rotation-settings');
      settings.style.display = enabled ? 'block' : 'none';
      saveConfig();
    }
    
    function updateLogRefreshRate() {
      const rate = parseInt(document.getElementById('log-refresh-rate').value) || 10;
      currentLogRefreshRate = Math.max(1, Math.min(60, rate)); // Clamp between 1-60 seconds
      
      // Restart the log update interval with new rate
      if (logInterval) {
        clearInterval(logInterval);
        logInterval = setInterval(updateLogs, currentLogRefreshRate * 1000);
      }
      
      saveConfig();
    }
    
    function updateConditionalConfig() {
      // Show/hide time-based message settings
      document.getElementById('morning-settings').style.display = 
        document.getElementById('morning-enabled').checked ? 'block' : 'none';
      document.getElementById('afternoon-settings').style.display = 
        document.getElementById('afternoon-enabled').checked ? 'block' : 'none';
      document.getElementById('evening-settings').style.display = 
        document.getElementById('evening-enabled').checked ? 'block' : 'none';
      
      // Show/hide context-based settings
      document.getElementById('low-context-settings').style.display = 
        document.getElementById('low-context-enabled').checked ? 'block' : 'none';
      document.getElementById('after-compact-settings').style.display = 
        document.getElementById('after-compact-enabled').checked ? 'block' : 'none';
    }
    
    function initializeTimeline() {
      const timelineAM = document.getElementById('schedule-timeline-am');
      const timelinePM = document.getElementById('schedule-timeline-pm');
      timelineAM.innerHTML = '';
      timelinePM.innerHTML = '';
      
      // Draw continuous blocks for AM
      drawTimelineBlocks(timelineAM, 0, 720);
      
      // Draw continuous blocks for PM
      drawTimelineBlocks(timelinePM, 720, 1440);
      
      // Set up drag handlers
      setupDragHandlers();
    }
    
    function drawTimelineBlocks(timeline, startMinute, endMinute) {
      // Find continuous blocks of same state
      let blocks = [];
      let currentBlock = null;
      
      for (let minute = startMinute; minute < endMinute; minute++) {
        const isActive = scheduleMinutes[minute];
        
        if (!currentBlock || currentBlock.isActive !== isActive) {
          // Start new block
          currentBlock = {
            start: minute,
            end: minute + 1,
            isActive: isActive
          };
          blocks.push(currentBlock);
        } else {
          // Extend current block
          currentBlock.end = minute + 1;
        }
      }
      
      // Draw each block
      blocks.forEach(block => {
        const segment = document.createElement('div');
        segment.className = 'timeline-block';
        
        const relativeStart = block.start - startMinute;
        const relativeEnd = block.end - startMinute;
        const rangeSize = endMinute - startMinute;
        
        const leftPercent = (relativeStart / rangeSize) * 100;
        const widthPercent = ((relativeEnd - relativeStart) / rangeSize) * 100;
        
        // Debug logging
        const startTime = (block.start / 60).toFixed(2);
        const endTime = (block.end / 60).toFixed(2);
        console.log(\`Block: \${startTime}h - \${endTime}h, Active: \${block.isActive}, Left: \${leftPercent.toFixed(2)}%, Width: \${widthPercent.toFixed(2)}%\`);
        
        segment.style.cssText = \`
          position: absolute;
          left: \${leftPercent}%;
          width: \${widthPercent}%;
          height: 100%;
          background: \${block.isActive ? 'var(--success)' : 'var(--danger)'};
          opacity: 0.8;
        \`;
        
        timeline.appendChild(segment);
      });
    }
    
    // Add drag functionality
    let isDragging = false;
    let startTime = null;
    let currentTool = 'active';
    let activeTimeline = null;
    let originalScheduleState = null; // Store original state before drag
    let isRightClickDrag = false; // Track if we're using right-click drag
    
    const getTimeFromX = (x, timeline) => {
        const rect = timeline.getBoundingClientRect();
        let percent = (x - rect.left) / rect.width;
        
        // If dragging past edges, snap to 0 or 1
        if (x < rect.left) percent = 0;
        if (x > rect.right) percent = 1;
        
        percent = Math.max(0, Math.min(1, percent));
        const isAM = timeline.id === 'schedule-timeline-am';
        const baseHour = isAM ? 0 : 12;
        return baseHour + (percent * 12);
      };
      
      const formatTime = (time) => {
        const hour = Math.floor(time);
        const minutes = Math.round((time - hour) * 60); // Changed from floor to round to fix precision issues
        const period = hour >= 12 ? 'PM' : 'AM';
        const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
        return \`\${displayHour}:\${minutes.toString().padStart(2, '0')} \${period}\`;
      };
      
      const updateTooltip = (e, timeline) => {
        const tooltip = document.getElementById('time-tooltip');
        const precision = parseInt(document.getElementById('schedule-precision').value);
        const rawTime = getTimeFromX(e.clientX, timeline);
        
        // Snap time to precision for display
        const minutes = rawTime * 60;
        const snappedMinutes = Math.round(minutes / precision) * precision;
        const snappedTime = snappedMinutes / 60;
        
        tooltip.textContent = formatTime(snappedTime);
        const rect = timeline.getBoundingClientRect();
        const parentRect = timeline.parentElement.parentElement.getBoundingClientRect();
        tooltip.style.left = \`\${e.clientX - parentRect.left - 25}px\`;
        tooltip.style.top = \`\${rect.top - parentRect.top - 25}px\`;
        tooltip.style.display = 'block';
      };
      
      // Add drag preview element
      let dragPreview = null;
      
      const updateRange = (startTime, endTime, isInitialDrag = false, isFinal = false) => {
        const tool = document.querySelector('input[name="schedule-tool"]:checked').value;
        // For right-click drag, use opposite tool
        const isActive = isRightClickDrag ? (tool === 'inactive') : (tool === 'active');
        const precision = parseInt(document.getElementById('schedule-precision').value);
        
        // Snap times to precision
        const snapToGrid = (time) => {
          const minutes = time * 60;
          const snappedMinutes = Math.round(minutes / precision) * precision;
          return snappedMinutes / 60;
        };
        
        const snappedStart = snapToGrid(startTime);
        const snappedEnd = snapToGrid(endTime);
        
        // First, restore the original minute-level state
        if (originalScheduleState && !isInitialDrag) {
          // Restore from saved minute array
          scheduleMinutes = [...originalScheduleState];
        }
        
        // Then apply the new selection at minute precision
        const minTime = Math.min(snappedStart, snappedEnd);
        const maxTime = Math.max(snappedStart, snappedEnd);
        
        const startMinute = Math.floor(minTime * 60);
        const endMinute = Math.ceil(maxTime * 60);
        
        // Update minute-level schedule
        for (let minute = startMinute; minute < endMinute; minute++) {
          if (minute >= 0 && minute < 1440) {
            scheduleMinutes[minute] = isActive;
          }
        }
        
        // Visual preview during drag (lightweight)
        if (!isFinal && activeTimeline) {
          updateDragPreview(activeTimeline, minTime, maxTime, isActive);
        }
        
        // Only full redraw on final update
        if (isFinal) {
          if (dragPreview) {
            dragPreview.remove();
            dragPreview = null;
          }
          initializeTimeline();
        }
      };
      
      const updateDragPreview = (timeline, minTime, maxTime, isActive) => {
        // Remove old preview if exists
        if (dragPreview) {
          dragPreview.remove();
        }
        
        // Create new preview overlay
        dragPreview = document.createElement('div');
        dragPreview.className = 'drag-preview';
        
        const isAM = timeline.id === 'schedule-timeline-am';
        const baseHour = isAM ? 0 : 12;
        const rangeStart = minTime - baseHour;
        const rangeEnd = maxTime - baseHour;
        
        const leftPercent = (rangeStart / 12) * 100;
        const widthPercent = ((rangeEnd - rangeStart) / 12) * 100;
        
        dragPreview.style.cssText = \`
          position: absolute;
          left: \${leftPercent}%;
          width: \${widthPercent}%;
          height: 100%;
          background: \${isActive ? 'var(--success)' : 'var(--danger)'};
          opacity: 0.5;
          pointer-events: none;
          z-index: 1000;
        \`;
        
        timeline.appendChild(dragPreview);
      };
      
    function setupDragHandlers() {
      const timelineAM = document.getElementById('schedule-timeline-am');
      const timelinePM = document.getElementById('schedule-timeline-pm');
      
      // Add event handlers to both timelines
      [timelineAM, timelinePM].forEach(timeline => {
        timeline.onmousedown = (e) => {
          // Handle both left and right click drag
          isDragging = true;
          isRightClickDrag = (e.button === 2);
          activeTimeline = timeline;
          startTime = getTimeFromX(e.clientX, timeline);
          // Capture the original minute-level state before any changes
          originalScheduleState = [...scheduleMinutes];
          updateTooltip(e, timeline);
          updateRange(startTime, startTime, true); // Initial click
        };
        
        // Prevent context menu on right click
        timeline.oncontextmenu = (e) => {
          e.preventDefault();
          return false;
        };
        
        timeline.onmousemove = (e) => {
          updateTooltip(e, timeline);
          if (isDragging && startTime !== null && activeTimeline === timeline) {
            const currentTime = getTimeFromX(e.clientX, timeline);
            updateRange(startTime, currentTime);
          }
        };
        
        timeline.onmouseup = (e) => {
          if (isDragging && startTime !== null) {
            const endTime = getTimeFromX(e.clientX, timeline);
            updateRange(startTime, endTime, false, true); // isFinal = true
            autoSave(); // Auto-save after schedule change
          }
          isDragging = false;
          isRightClickDrag = false;
          startTime = null;
          activeTimeline = null;
          originalScheduleState = null; // Clear the saved state
        };
        
        timeline.onmouseleave = () => {
          document.getElementById('time-tooltip').style.display = 'none';
          // Don't cancel drag when leaving - let global handlers deal with it
        };
        
        // Prevent text selection
        timeline.onselectstart = () => false;
      });
      
      // Global mouse handlers for dragging outside timeline
      document.addEventListener('mousemove', (e) => {
        if (isDragging && startTime !== null && activeTimeline) {
          const rect = activeTimeline.getBoundingClientRect();
          const isWithinVerticalBounds = e.clientY >= rect.top && e.clientY <= rect.bottom;
          
          if (isWithinVerticalBounds) {
            // Continue drag even if mouse is outside horizontal bounds
            const currentTime = getTimeFromX(e.clientX, activeTimeline);
            updateRange(startTime, currentTime);
          }
        }
      });
      
      document.addEventListener('mouseup', (e) => {
        if (isDragging && startTime !== null && activeTimeline) {
          const rect = activeTimeline.getBoundingClientRect();
          const isWithinVerticalBounds = e.clientY >= rect.top && e.clientY <= rect.bottom;
          
          let endTime;
          if (isWithinVerticalBounds) {
            endTime = getTimeFromX(e.clientX, activeTimeline);
          } else {
            // If released outside vertical bounds, use the last known position
            const lastX = e.clientX < rect.left ? rect.left : 
                         e.clientX > rect.right ? rect.right : e.clientX;
            endTime = getTimeFromX(lastX, activeTimeline);
          }
          
          updateRange(startTime, endTime, false, true); // isFinal = true
          autoSave();
        }
        
        // Always clear drag state on global mouseup
        isDragging = false;
        isRightClickDrag = false;
        startTime = null;
        activeTimeline = null;
        originalScheduleState = null;
      });
    }
    
    function setAllHours(active) {
      scheduleMinutes = new Array(1440).fill(active);
      updateTimeline();
      autoSave();
    }
    
    function setWorkHours() {
      scheduleMinutes = new Array(1440).fill(false);
      // Active 9 AM to 5 PM (9*60 to 17*60)
      for (let minute = 540; minute < 1020; minute++) {
        scheduleMinutes[minute] = true;
      }
      updateTimeline();
      autoSave();
    }
    
    function setNightHours() {
      scheduleMinutes = new Array(1440).fill(false);
      // Active 10 PM to 6 AM (22*60 to 24*60 and 0 to 6*60)
      for (let minute = 1320; minute < 1440; minute++) {
        scheduleMinutes[minute] = true;
      }
      for (let minute = 0; minute <= 360; minute++) {
        scheduleMinutes[minute] = true;
      }
      updateTimeline();
      autoSave();
    }
    
    function updateTimeline() {
      // Simply redraw the timeline with current data
      initializeTimeline();
    }
    
    function updateScheduleSettings() {
      const checkbox = document.getElementById('schedule-enabled');
      const settings = document.getElementById('schedule-settings');
      
      const enabled = checkbox?.checked || false;
      if (settings) {
        settings.style.display = enabled ? 'block' : 'none';
      }
      if (enabled) {
        initializeTimeline();
        // Update timezone display
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const tzDisplay = document.getElementById('timezone-display');
        if (tzDisplay) {
          tzDisplay.textContent = \`Timezone: \${tz} (all times shown in local time)\`;
        }
      }
    }
    
    function updateStartTimeSettings() {
      const useStartTime = document.getElementById('use-start-time').checked;
      const startTimeGroup = document.getElementById('start-time-group');
      const delayInput = document.getElementById('delay-minutes');
      const delayGroup = delayInput?.parentElement;
      
      if (startTimeGroup) {
        startTimeGroup.style.display = useStartTime ? 'block' : 'none';
      }
      if (delayGroup) {
        delayGroup.style.display = useStartTime ? 'none' : 'block';
      }
    }
    
    function toggleConfigPanel() {
      const configContent = document.getElementById('config-content');
      const configToggle = document.getElementById('config-toggle');
      const configPanel = document.getElementById('config-panel');
      const logPanel = document.getElementById('log-panel');
      const grid = document.getElementById('main-grid');
      
      if (configContent.style.display === 'none') {
        configContent.style.display = 'block';
        configToggle.textContent = '▼';
        configPanel.style.width = '';
        grid.style.gridTemplateColumns = '450px 1fr';
      } else {
        configContent.style.display = 'none';
        configToggle.textContent = '▶';
        configPanel.style.width = 'auto';
        grid.style.gridTemplateColumns = 'auto 1fr';
      }
    }
    
    // Auto-save functionality
    let saveTimeout;
    function autoSave() {
      console.log('Auto-save triggered');
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        console.log('Calling saveConfig...');
        saveConfig();
      }, 500); // Save 500ms after last change
    }
    
    
    // Wait for DOM to be ready before attaching event listeners and loading config
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initializeDashboard);
    } else {
      // DOM is already ready
      initializeDashboard();
    }
    
    function initializeDashboard() {
      // Event listeners
      document.getElementById('context-aware').addEventListener('change', () => {
        updateContextSettings();
        autoSave();
      });
      document.getElementById('schedule-enabled').addEventListener('change', () => {
        updateScheduleSettings();
        autoSave();
      });
      document.getElementById('use-start-time').addEventListener('change', () => {
        updateStartTimeSettings();
        autoSave();
      });
      
      // Add event listener for new session button
      const newSessionBtn = document.getElementById('new-session-btn');
      if (newSessionBtn) {
        newSessionBtn.addEventListener('click', async () => {
          try {
            // Simple inline implementation
            const sessions = Array.from(document.getElementById('session-select').options).map(opt => opt.value);
            const loopSessions = sessions.filter(s => s.startsWith('claude-loop'));
            const numbers = loopSessions.map(s => {
              const match = s.match(/claude-loop(\\d+)/);
              return match ? parseInt(match[1]) : 0;
            });
            let nextNum = 1;
            while (numbers.includes(nextNum)) nextNum++;
            const newSessionName = 'claude-loop' + nextNum;
            
            // Show creating message
            const logsEl = document.getElementById('logs');
            if (logsEl) {
              logsEl.innerHTML = '<span style="color: var(--success);">✅ Creating session: ' + newSessionName + '...</span>';
            }
            
            // Create the session
            const response = await fetch('/api/tmux-setup', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                session: newSessionName, 
                action: 'create' 
              })
            });
            
            if (response.ok) {
              // Reload page after delay
              setTimeout(() => {
                window.location.reload();
              }, 1500);
            } else {
              alert('Failed to create session');
            }
          } catch (error) {
            console.error('Error creating session:', error);
            alert('Error: ' + error.message);
          }
        });
      }
      
      // Add scroll listener for virtual scrolling
      let scrollTimeout;
      document.getElementById('logs').addEventListener('scroll', (e) => {
        // Mark that user has scrolled
        e.target.setAttribute('data-user-scrolled', 'true');
        
        // Only trigger virtual scrolling updates if lazy loading is enabled
        if (lazyLoadingEnabled) {
          // Debounce scroll updates
          clearTimeout(scrollTimeout);
          scrollTimeout = setTimeout(() => {
            if (allLogLines.length > 100) { // Only use virtual scrolling for large logs
              updateLogs(true); // Pass true to indicate this is a scroll update
            }
          }, 100);
        }
      });
      
      // Initialize
      loadConfig().then(() => {
      // Small delay to ensure DOM updates are complete
      setTimeout(() => {
        // Add auto-save to all inputs after config is loaded
        const inputs = document.querySelectorAll('input, textarea, select');
        console.log('Found', inputs.length, 'inputs to add auto-save to');
        inputs.forEach(input => {
          if (input.type === 'checkbox' || input.type === 'radio') {
            input.addEventListener('change', autoSave);
          } else {
            input.addEventListener('input', autoSave);
          }
        });
      }, 100);
      
      // Start intervals AFTER config is loaded so we use the correct refresh rate
      updateStatus();
      updateContext();
      updateLogs();
      loadTmuxSessions(); // Load available sessions
      
      // Auto-refresh
      statusInterval = setInterval(() => {
        updateStatus();
        updateContext();
      }, 5000);
      
      // Use the loaded refresh rate value
      console.log('Starting log refresh with rate:', currentLogRefreshRate, 'seconds');
      logInterval = setInterval(updateLogs, currentLogRefreshRate * 1000);
    });
  } // End of initializeDashboard function
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

// Initialize
loadConfig().then(() => {
  server.listen(CONFIG.port, '0.0.0.0', () => {
    console.log(`🎮 Claude Loop Unified Dashboard running at:`);
    console.log(`   - http://localhost:${CONFIG.port}`);
    console.log(`   - http://192.168.1.2:${CONFIG.port}`);
    console.log(`✨ Features:`);
    console.log(`   - Full configuration control`);
    console.log(`   - Real-time context monitoring`);
    console.log(`   - Custom messages on-the-fly`);
    console.log(`   - Start/stop/pause/resume`);
    console.log(`   - Persistent settings`);
  });
});