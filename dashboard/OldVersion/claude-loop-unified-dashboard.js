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
const os = require('os');
const execAsync = util.promisify(exec);

// Get the user's home directory
const HOME_DIR = os.homedir();

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

// Import session tracker and matcher
const SimpleClaudeSessionTracker = require('./claude-session-tracker-simple.js');
const sessionTracker = new SimpleClaudeSessionTracker();
const ClaudeSessionMatcher = require('./claude-session-matcher.js');
const sessionMatcher = new ClaudeSessionMatcher();

// Context thresholds (hardcoded for visual indicators)
const contextWarningPercent = 20;
const contextCriticalPercent = 10;

// Default loop configuration
let loopConfig = {
  customName: "", // Custom display name for the loop
  delayMinutes: 10,
  startWithDelay: true, // Whether to wait for delay before first message
  useStartTime: false,
  startTime: "09:00",
  contextAware: true,
  customMessage: "",
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
    standardMessage: {
      enabled: false,
      message: "Please continue with the current task."
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
          const session = parsedUrl.query.session;
          if (session) {
            // Try to load session-specific config
            const sessionConfigFile = path.join(__dirname, 'loop-config-' + session + '.json');
            try {
              const data = await fs.readFile(sessionConfigFile, 'utf-8');
              const sessionConfig = JSON.parse(data);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(sessionConfig));
            } catch (e) {
              // No session config exists
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'No config for session' }));
            }
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(loopConfig));
          }
        } else if (method === 'POST') {
          const data = JSON.parse(body);
          if (data.session) {
            // Save session-specific config
            const sessionConfigFile = path.join(__dirname, 'loop-config-' + data.session + '.json');
            await fs.writeFile(sessionConfigFile, JSON.stringify(data.config, null, 2));
            console.log('Config saved to: ' + sessionConfigFile);
          } else {
            // Save global config
            loopConfig = { ...loopConfig, ...data };
            await saveConfig();
          }
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
        const sessionParam = parsedUrl.query.session;
        const context = await getContextStatus(sessionParam);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(context));
        break;

      case '/api/log-monitor':
        if (method === 'POST') {
          const data = JSON.parse(body);
          const instance = data.instance || 'default';
          const session = data.session || 'claude-chat';
          let command = '/home/michael/InfiniQuest/tmp/claudeLoop/dashboard/log-monitor-manager.sh ' + data.action + ' ' + instance;
          if (data.action === 'start' && data.session) {
            command += ' ' + session;
          }
          const result = await execCommand(command);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: result.includes('OK:'), message: result }));
        }
        break;
        
      case '/api/monitor-type':
        if (method === 'POST') {
          const data = JSON.parse(body);
          const fs = require('fs').promises;
          const path = require('path');
          const typeFile = path.join('/tmp/claude-monitors/monitor-type-preference');
          await fs.writeFile(typeFile, data.type);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, type: data.type }));
        }
        break;
        
      case '/api/log-monitor/status':
        const instance = parsedUrl.query.instance || 'default';
        const statusResult = await execCommand('/home/michael/InfiniQuest/tmp/claudeLoop/dashboard/log-monitor-manager.sh status ' + instance);
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
        
      case '/api/sessions':
        // Return info about all known sessions (for compatibility)
        const sessionInfo = {};
        for (const [session, loopInfo] of sessionLoops.entries()) {
          sessionInfo[session] = {
            active: true,
            paused: loopInfo.paused,
            hasLoop: true
          };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sessions: sessionInfo }));
        break;
        
      case '/api/tmux-setup':
        if (method === 'POST') {
          const setupData = JSON.parse(body);
          const session = setupData.session || 'claude-chat';
          const action = setupData.action || 'ensure';
          const setupResult = await execCommand('/home/michael/InfiniQuest/tmp/claudeLoop/dashboard/tmux-claude-setup.sh ' + session + ' ' + action);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: setupResult }));
        }
        break;
        
      case '/api/conversation/track':
        if (method === 'POST') {
          const data = JSON.parse(body);
          const session = data.session;
          const convInfo = await sessionTracker.trackActiveSession(session);
          
          // Auto-name the conversation from loop's custom name if available
          if (convInfo && convInfo.id) {
            try {
              // Check if it already has a custom name
              const conversationNamer = require('./conversation-names');
              const existingName = await conversationNamer.getName(convInfo.id);
              
              if (!existingName) {
                // Try to get the loop config for this session
                const configFile = path.join(__dirname, 'loop-config-' + session + '.json');
                try {
                  const configData = await fs.readFile(configFile, 'utf-8');
                  const config = JSON.parse(configData);
                  
                  if (config.customName && config.customName.trim()) {
                    // Set the conversation name to the loop's custom name
                    await conversationNamer.setName(convInfo.id, config.customName);
                    console.log(`Auto-named conversation ${convInfo.id} as "${config.customName}"`);
                  }
                } catch (configErr) {
                  // No config file or error reading it, that's fine
                }
              }
            } catch (err) {
              console.error('Error auto-naming conversation:', err);
            }
          }
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, conversation: convInfo }));
        }
        break;
        
      case '/api/conversation/get':
        const session = parsedUrl.query.session;
        const tracked = await sessionTracker.getTrackedConversation(session);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(tracked || {}));
        break;
        
      case '/api/conversation/list':
        const grouped = parsedUrl.query.grouped === 'true';
        if (grouped) {
          const groupedConversations = await sessionTracker.getAllProjectConversations();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ conversations: groupedConversations, grouped: true }));
        } else {
          const conversations = await sessionTracker.listConversations(20);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ conversations }));
        }
        break;
        
      case '/api/conversation/assign':
        if (method === 'POST') {
          const data = JSON.parse(body);
          const { session, conversationId, workingDirectory } = data;
          
          // Manually assign a conversation to a session
          await sessionMatcher.setSessionConversation(session, conversationId, workingDirectory || process.cwd());
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: `Assigned conversation ${conversationId} to ${session}` }));
        }
        break;
        
      case '/api/browse-directory':
        if (method === 'POST') {
          const data = JSON.parse(body);
          const dir = data.directory || HOME_DIR;
          
          try {
            // Read directory contents
            const items = await fs.readdir(dir, { withFileTypes: true });
            
            // Filter and sort directories
            const directories = items
              .filter(item => item.isDirectory() && !item.name.startsWith('.'))
              .map(item => ({
                name: item.name,
                path: path.join(dir, item.name)
              }))
              .sort((a, b) => a.name.localeCompare(b.name));
            
            // Add parent directory if not at root
            if (dir !== '/') {
              directories.unshift({
                name: '..',
                path: path.dirname(dir)
              });
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
              currentPath: dir,
              directories: directories 
            }));
          } catch (error) {
            console.error('Error browsing directory:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
          }
        }
        break;
        
      case '/api/conversation/delete':
        if (method === 'POST') {
          const data = JSON.parse(body);
          const { conversationId, projectPath } = data;
          
          try {
            // Build the file path
            const projectDir = projectPath.replace(/\//g, '-').replace(/_/g, '-');
            const filePath = path.join(os.homedir(), '.claude', 'projects', projectDir, conversationId + '.jsonl');
            
            // Create trash directory if it doesn't exist
            const trashDir = path.join(os.homedir(), '.claude', 'projects', projectDir, '.trash');
            await fs.mkdir(trashDir, { recursive: true });
            
            // Move file to trash
            const trashPath = path.join(trashDir, conversationId + '.jsonl');
            await fs.rename(filePath, trashPath);
            
            console.log(`Moved conversation ${conversationId} to trash`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } catch (error) {
            console.error('Error deleting conversation:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
          }
        }
        break;
        
      case '/api/conversation/name':
        if (method === 'POST') {
          const data = JSON.parse(body);
          const { conversationId, name } = data;
          const conversationNamer = require('./conversation-names');
          await conversationNamer.setName(conversationId, name);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, name }));
        } else if (method === 'GET') {
          const conversationId = parsedUrl.query.conversationId;
          const conversationNamer = require('./conversation-names');
          const name = await conversationNamer.getName(conversationId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ name }));
        } else if (method === 'DELETE') {
          const conversationId = parsedUrl.query.conversationId;
          const conversationNamer = require('./conversation-names');
          await conversationNamer.removeName(conversationId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        }
        break;

      case '/api/conversation/tree':
        const ConversationTreeScanner = require('./conversation-tree-scanner');
        const treeScanner = new ConversationTreeScanner();
        
        if (method === 'GET') {
          // Check if we should refresh (based on trigger)
          const forceRefresh = parsedUrl.query.refresh === 'true';
          const tree = await treeScanner.getConversationTree(forceRefresh);
          const structured = treeScanner.buildTreeStructure(tree.conversations);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            tree: structured,
            totalCount: Object.keys(tree.conversations).length,
            lastScan: tree.lastScanTimestamp
          }));
        }
        break;
        
      case '/api/conversation/scan':
        if (method === 'POST') {
          const ConversationTreeScanner = require('./conversation-tree-scanner');
          const treeScanner = new ConversationTreeScanner();
          const full = parsedUrl.query.full === 'true';
          
          const result = full 
            ? await treeScanner.fullScan()
            : await treeScanner.incrementalScan();
            
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            updatedCount: result.updatedCount,
            deletedCount: result.deletedCount,
            totalCount: result.totalCount
          }));
        }
        break;
        
      case '/api/conversation/lineage':
        if (method === 'GET') {
          const conversationId = parsedUrl.query.conversationId;
          if (!conversationId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'conversationId required' }));
            break;
          }
          
          const ConversationTreeScanner = require('./conversation-tree-scanner');
          const treeScanner = new ConversationTreeScanner();
          const lineage = await treeScanner.getConversationLineage(conversationId);
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ lineage }));
        }
        break;

      case '/api/loop/pause':
        if (method === 'POST') {
          const data = JSON.parse(body);
          const session = data.session;
          if (session && sessionLoops.has(session)) {
            const loopInfo = sessionLoops.get(session);
            loopInfo.paused = true;
            await saveActiveLoops();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: `Session ${session} paused` }));
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Session not found' }));
          }
        }
        break;
        
      case '/api/loop/resume':
        if (method === 'POST') {
          const data = JSON.parse(body);
          const session = data.session;
          if (session && sessionLoops.has(session)) {
            const loopInfo = sessionLoops.get(session);
            loopInfo.paused = false;
            await saveActiveLoops();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: `Session ${session} resumed` }));
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Session not found' }));
          }
        }
        break;
        
      case '/api/loop/status':
        const loops = {};
        for (const [session, info] of sessionLoops.entries()) {
          loops[session] = {
            paused: info.paused,
            startTime: info.startTime,
            nextMessageTime: info.nextMessageTime
          };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ loops }));
        break;

      case '/api/control':
        if (method === 'POST') {
          const data = JSON.parse(body);
          switch (data.action) {
            case 'start':
              await startLoop(data.session || 'claude', data.config || loopConfig);
              break;
            case 'stop':
              // Stop only the specified session
              await stopLoop(data.session || 'claude');
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
            case 'stop-all-loops':
              // Stop only the loop processes, not the tmux sessions
              try {
                // First, try to stop all tracked loops gracefully
                try {
                  if (sessionLoops && sessionLoops.size > 0) {
                    for (const [sess, loopInfo] of sessionLoops.entries()) {
                      if (loopInfo && loopInfo.intervalId) {
                        clearInterval(loopInfo.intervalId);
                      }
                    }
                    sessionLoops.clear();
                  }
                } catch (e) {
                  console.error('Error clearing intervals:', e);
                }
                
                // Kill all claude loop processes
                const { stdout } = await execAsync('ps aux | grep -E "claude.*loop|claude-loop" | grep -v grep | grep -v dashboard | awk \'{print $2}\'');
                const pids = stdout.trim().split('\n').filter(pid => pid);
                
                for (const pid of pids) {
                  if (pid) {
                    try {
                      await execAsync('kill -9 ' + pid);
                    } catch (e) {
                      // Process might already be gone
                    }
                  }
                }
                
                // Clean up files - including our new lock format
                await execAsync('rm -f /tmp/claude-loop*.lock 2>/dev/null').catch(() => {});
                await execAsync('rm -f /tmp/claude_loop_*.lock 2>/dev/null').catch(() => {});
                await execAsync('rm -f /tmp/claude_loop_*.pid 2>/dev/null').catch(() => {});
                await execAsync('rm -f /tmp/claude-monitor*.pid 2>/dev/null').catch(() => {});
                
                // Clear active loops file
                await fs.writeFile(ACTIVE_LOOPS_FILE, '{}').catch(() => {});
                
                console.log('Stopped all loops');
              } catch (e) {
                console.error('Error in stop-all-loops:', e);
              }
              break;
              
            case 'stop-all-sessions':
              // Stop all tmux sessions (claude sessions)
              try {
                // Get all tmux sessions that start with 'claude'
                const { stdout: sessionList } = await execAsync('tmux list-sessions -F "#{session_name}" 2>/dev/null | grep "^claude" || true');
                const sessions = sessionList.trim().split('\n').filter(s => s);
                
                // Kill each claude session
                for (const session of sessions) {
                  if (session) {
                    try {
                      await execAsync(`tmux kill-session -t "${session}"`);
                      console.log(`Killed tmux session: ${session}`);
                    } catch (e) {
                      console.error(`Failed to kill session ${session}:`, e.message);
                    }
                  }
                }
                
                // Also stop all loops since sessions are gone
                // First, try to stop all tracked loops gracefully
                try {
                  if (sessionLoops && sessionLoops.size > 0) {
                    for (const [sess, loopInfo] of sessionLoops.entries()) {
                      if (loopInfo && loopInfo.intervalId) {
                        clearInterval(loopInfo.intervalId);
                      }
                    }
                    sessionLoops.clear();
                  }
                } catch (e) {
                  console.error('Error clearing intervals:', e);
                }
                
                // Kill all claude loop processes
                const { stdout } = await execAsync('ps aux | grep -E "claude.*loop|claude-loop" | grep -v grep | grep -v dashboard | awk \'{print $2}\'');
                const pids = stdout.trim().split('\n').filter(pid => pid);
                
                for (const pid of pids) {
                  if (pid) {
                    try {
                      await execAsync('kill -9 ' + pid);
                    } catch (e) {
                      // Process might already be gone
                    }
                  }
                }
                
                // Clean up files
                await execAsync('rm -f /tmp/claude-loop*.lock 2>/dev/null').catch(() => {});
                await execAsync('rm -f /tmp/claude_loop_*.lock 2>/dev/null').catch(() => {});
                await execAsync('rm -f /tmp/claude_loop_*.pid 2>/dev/null').catch(() => {});
                await execAsync('rm -f /tmp/claude-monitor*.pid 2>/dev/null').catch(() => {});
                
                // Clear active loops file
                await fs.writeFile(ACTIVE_LOOPS_FILE, '{}').catch(() => {});
                
                console.log('Stopped all claude sessions and loops');
              } catch (e) {
                console.error('Error in stop-all-sessions:', e);
              }
              break;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        }
        break;

      case '/api/next-message':
        const msgSessionParam = parsedUrl.query.session;
        const message = await getConditionalMessage(msgSessionParam);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(message);
        break;

      case '/api/pause-status':
        const pauseStatus = await getPauseStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(pauseStatus));
        break;
        
      case '/api/schedule-active':
        const scheduleSession = parsedUrl.query.session;
        if (!scheduleSession) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Error: session parameter required');
          break;
        }
        const isActive = isScheduleActive(scheduleSession);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(isActive ? 'true' : 'false');
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

      case '/api/send-custom-message':
        if (method === 'POST') {
          const data = JSON.parse(body);
          const session = data.session || 'claude';
          const message = data.message || '';
          await sendCustomMessage(message, session);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        }
        break;
        
      case '/api/send-key':
        if (method === 'POST') {
          const data = JSON.parse(body);
          const session = data.session || 'claude';
          const key = data.key;
          // Properly escape the key for tmux
          const tmuxKey = key === 'C-c' ? 'C-c' : key;
          await execAsync(`tmux send-keys -t ${session} ${tmuxKey}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        }
        break;
        
      case '/api/kill-session':
        if (method === 'POST') {
          const data = JSON.parse(body);
          const session = data.session || 'claude';
          await execAsync('tmux kill-session -t ' + session);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        }
        break;
        
      case '/api/upload-file':
        if (method === 'POST') {
          const data = JSON.parse(body);
          const { filename, content, type } = data;
          
          // Create uploads directory if it doesn't exist
          const uploadsDir = path.join(HOME_DIR, '.claude-uploads');
          await fs.mkdir(uploadsDir, { recursive: true });
          
          // Generate unique filename with timestamp
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const ext = path.extname(filename);
          const baseName = path.basename(filename, ext);
          const uniqueFilename = `${baseName}_${timestamp}${ext}`;
          const filePath = path.join(uploadsDir, uniqueFilename);
          
          // Decode base64 content and save file
          const buffer = Buffer.from(content, 'base64');
          await fs.writeFile(filePath, buffer);
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            success: true, 
            filePath: filePath,
            filename: uniqueFilename 
          }));
        }
        break;
        
      case '/api/start-session':
        if (method === 'POST') {
          const data = JSON.parse(body);
          const session = data.session || 'claude';
          const workingDir = data.workingDir || '/home/michael/InfiniQuest';
          // Create new tmux session and start claude with resume option in the specified directory
          await execAsync('tmux new-session -d -s ' + session + ' -c "' + workingDir + '" \'claude --resume\'');
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
    const pauseStatus = await getPauseStatus();
    const isPaused = pauseStatus.paused;
    
    // Check memory first
    let runningLoops = [];
    let loopDetails = {};
    
    for (const [session, loopInfo] of sessionLoops.entries()) {
      if (loopInfo && loopInfo.intervalId) {
        runningLoops.push(session);
        loopDetails[session] = {
          nextMessageTime: loopInfo.nextMessageTime ? loopInfo.nextMessageTime.toISOString() : null,
          delayMinutes: loopInfo.delayMinutes || loopConfig.delayMinutes,
          paused: isPaused
        };
        
        // If paused, add the pause info
        if (isPaused && pauseStatus.loops && pauseStatus.loops[session]) {
          loopDetails[session].timeRemaining = pauseStatus.loops[session].timeRemaining;
          loopDetails[session].pausedAt = pauseStatus.pausedAt;
        }
      }
    }
    
    // If no loops in memory, check persistent file
    if (runningLoops.length === 0) {
      const activeLoops = await loadActiveLoops();
      runningLoops = Object.keys(activeLoops).filter(session => activeLoops[session].active);
    }
    
    return {
      running: runningLoops.length > 0,
      paused: isPaused,
      sessions: runningLoops,
      count: runningLoops.length,
      config: loopConfig,
      loopDetails: loopDetails
    };
  } catch (error) {
    return { running: false, paused: false, sessions: [], count: 0, error: error.message };
  }
}

async function scrapeContextFromTmux(session) {
  try {
    // Capture the visible window from tmux (what's currently on screen)
    const { stdout: visibleContent } = await execAsync(`tmux capture-pane -pt "${session}" -e 2>/dev/null || echo ""`);
    
    // Debug mode - log what we capture when looking for context
    if (process.env.DEBUG_CONTEXT_SCRAPING) {
      console.log('=== TMUX CAPTURE DEBUG ===');
      console.log(visibleContent);
      console.log('=== END CAPTURE ===');
    }
    
    // Find everything after the input box bottom border
    // Look for a more specific pattern to avoid false positives
    // The bottom border typically looks like: ╰────────────────╯
    let inputBoxMatch = visibleContent.match(/─{3,}╯([^]*?)$/);
    if (!inputBoxMatch) {
      // Try simpler pattern as fallback
      inputBoxMatch = visibleContent.match(/╯([^]*?)$/);
      if (!inputBoxMatch) {
        // No input box found, can't identify status area
        if (process.env.DEBUG_CONTEXT_SCRAPING) {
          console.log('No input box border found in visible content');
        }
        return null;
      }
    }
    
    // Get all text after the input box
    const statusAreaText = inputBoxMatch[1];
    
    // Look for a percentage number near the word "context"
    // Common formats:
    // - "Context low (34% remaining)"
    // - "Context: 15%"
    // - "15% Context"
    // The [\s\S] matches any character including newlines
    const contextPatterns = [
      // Primary pattern for "Context low (34% remaining)"
      /context\s+low\s*\((\d+)%\s*remaining\)/i,
      // Generic patterns for other formats
      /context[\s\S]{0,20}?(\d+)%/i,
      /(\d+)%[\s\S]{0,20}?context/i,
      // Pattern with parentheses
      /context[^(]*\((\d+)%/i,
    ];
    
    for (const pattern of contextPatterns) {
      const match = statusAreaText.match(pattern);
      if (match) {
        const percentage = parseInt(match[1]);
        console.log(`Found context in status area: ${percentage}% remaining (pattern: ${pattern.source})`);
        return percentage;
      }
    }
    
    return null;
  } catch (e) {
    console.error('Error scraping context from tmux:', e);
    return null;
  }
}

async function getContextStatus(sessionName = null) {
  try {
    // Get session from query parameter
    const session = sessionName;
    if (!session) {
      throw new Error('Session name is required');
    }
    // First try to scrape actual context from tmux
    const scrapedContext = await scrapeContextFromTmux(session);
    if (scrapedContext !== null) {
      console.log(`Scraped context from tmux for ${session}: ${scrapedContext}%`);
      return {
        contextPercent: scrapedContext,
        timestamp: new Date().toISOString(),
        source: 'tmux',
        logSize: 0,
        lastCompact: null
      };
    }
    
    // Fall back to log-based estimation
    const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '-');
    const currentLog = path.join(CONFIG.logDir, `${session}_${dateStr}.log`);
    
    let stat;
    try {
      stat = await fs.stat(currentLog);
    } catch (e) {
      // Try the general claude log if session-specific doesn't exist
      const generalLog = path.join(CONFIG.logDir, `claude_${dateStr}_current.txt`);
      stat = await fs.stat(generalLog);
    }
    
    const logSize = stat.size;
    
    // Look for last compact - need to use the correct file path
    let content;
    try {
      content = await fs.readFile(currentLog, 'utf-8');
    } catch (e) {
      // Try the general log if session-specific fails
      const generalLog = path.join(CONFIG.logDir, `claude_${dateStr}_current.txt`);
      content = await fs.readFile(generalLog, 'utf-8');
    }
    
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
    // Require session name
    const session = sessionName;
    if (!session) {
      throw new Error('Session name is required');
    }
    // ANSI logs have no date, just session name
    let currentLogPath = path.join(ansiLogDir, session + '.log');
    
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

async function getConditionalMessage(sessionName = null) {
  const now = new Date();
  const hour = now.getHours();
  
  // Load session-specific config if available
  let config;
  try {
    const sessionConfigFile = path.join(__dirname, `loop-config-${sessionName}.json`);
    const sessionConfigData = await fs.readFile(sessionConfigFile, 'utf-8');
    const sessionConfig = JSON.parse(sessionConfigData);
    config = sessionConfig.conditionalMessages || loopConfig.conditionalMessages;
    console.log(`Using session config for ${sessionName}:`, config.standardMessage);
  } catch (e) {
    // Fall back to global config
    config = loopConfig.conditionalMessages;
    console.log(`Using global config for ${sessionName}`);
  }
  
  // Helper function to add auto-finish instruction to any message
  function addAutoFinishInstruction(message) {
    if (config.lowContextMessage?.autoFinish) {
      message += '\n\nIf you\'ve completed all of your todo items and can\'t think of anything you should do right now to improve the project, then respond with "Finished_everything_for_now!" (without the underscores)';
    }
    return message;
  }
  
  // Priority order (first match wins):
  // 1. Context-critical messages (most important)
  try {
    const context = await getContextStatus(sessionName);
    
    // After compact message (highest priority - fresh context needs direction)
    if (config.afterCompactMessage?.enabled && context.lastCompact && context.lastCompact <= config.afterCompactMessage.linesAfterCompact) {
      return addAutoFinishInstruction(config.afterCompactMessage.message);
    }
    
    // Low context message (high priority - needs action)
    if (config.lowContextMessage?.enabled && context.contextPercent <= config.lowContextMessage.threshold) {
      let message = config.lowContextMessage.message;
      // Add auto-compact instruction if enabled
      if (config.lowContextMessage.autoCompact) {
        message += '\n\nAlso, when you\'re ready to compact, please reply with this exact phrase: "Let\'s compact!"';
      }
      return addAutoFinishInstruction(message);
    }
  } catch (e) {}
  
  // 2. Session duration (medium priority)
  if (config.longSessionMessage?.enabled) {
    try {
      const logPath = path.join(CONFIG.logDir, 'claude_' + new Date().toISOString().split('T')[0] + '_current.txt');
      const stat = await fs.stat(logPath);
      const hoursSinceStart = (Date.now() - stat.birthtime.getTime()) / (1000 * 60 * 60);
      if (hoursSinceStart >= config.longSessionMessage.hoursThreshold) {
        return addAutoFinishInstruction(config.longSessionMessage.message);
      }
    } catch (e) {}
  }
  
  // 3. Time-based messages (lower priority - general guidance)
  if (config.morningMessage?.enabled && hour >= config.morningMessage.startHour && hour < config.morningMessage.endHour) {
    return addAutoFinishInstruction(config.morningMessage.message);
  }
  if (config.afternoonMessage?.enabled && hour >= config.afternoonMessage.startHour && hour < config.afternoonMessage.endHour) {
    return addAutoFinishInstruction(config.afternoonMessage.message);
  }
  if (config.eveningMessage?.enabled && hour >= config.eveningMessage.startHour && hour < config.eveningMessage.endHour) {
    return addAutoFinishInstruction(config.eveningMessage.message);
  }
  
  // 4. Standard message (if no other conditions match)
  if (config.standardMessage?.enabled) {
    return addAutoFinishInstruction(config.standardMessage.message);
  }
  
  // 5. Default custom message (fallback)
  return addAutoFinishInstruction(loopConfig.customMessage);
}

// Session loops tracking
const sessionLoops = new Map(); // session -> { pid, intervalId, paused }

// Keep track of active loops in a file for persistence
const ACTIVE_LOOPS_FILE = path.join(__dirname, 'active-loops.json');

async function loadActiveLoops() {
  try {
    const data = await fs.readFile(ACTIVE_LOOPS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    return {};
  }
}

async function saveActiveLoops() {
  try {
    const activeLoops = {};
    for (const [session, info] of sessionLoops.entries()) {
      activeLoops[session] = {
        startTime: info.startTime,
        active: true,
        paused: info.paused || false,
        nextMessageTime: info.nextMessageTime,
        delayMinutes: info.delayMinutes
      };
    }
    await fs.writeFile(ACTIVE_LOOPS_FILE, JSON.stringify(activeLoops, null, 2));
  } catch (e) {
    console.error('Failed to save active loops:', e);
  }
}

function isScheduleActive(session) {
  // Get current time in minutes since midnight
  const now = new Date();
  const currentMinute = now.getHours() * 60 + now.getMinutes();
  
  // Check if this minute is active in the schedule
  // Note: scheduleMinutes is a global array tracking the schedule state
  return scheduleMinutes[currentMinute] || false;
}

async function startLoop(session = 'claude', config = loopConfig) {
  // Check if loop already exists for this session
  if (sessionLoops.has(session)) {
    console.log('Loop already running for session: ' + session);
    return;
  }
  
  // Calculate when the first message should be sent
  const delayMs = config.delayMinutes * 60 * 1000;
  const now = new Date();
  const minSafetyDelay = 30 * 1000; // 30 seconds minimal delay for safety
  const firstMessageTime = config.startWithDelay 
    ? new Date(now.getTime() + delayMs) 
    : new Date(now.getTime() + minSafetyDelay);
  
  // Send first message after appropriate delay
  if (!config.startWithDelay) {
    // If NOT starting with delay, send after safety delay (30 seconds)
    setTimeout(async () => {
      try {
        const message = await getConditionalMessage(session) || config.customMessage;
        if (message) {
          await sendCustomMessage(message, session);
          console.log(`Sent initial message to ${session}: ${message} (after safety delay)`);
        }
        // Update next message time after sending
        const loopInfo = sessionLoops.get(session);
        if (loopInfo) {
          loopInfo.nextMessageTime = new Date(Date.now() + config.delayMinutes * 60 * 1000);
        }
      } catch (error) {
        console.error('Error sending initial message for ' + session + ':', error);
      }
    }, minSafetyDelay); // Wait for safety delay
  }
  // If startWithDelay is true, the regular interval will handle the first message
  
  // Create a session-specific loop
  const loopInterval = setInterval(async () => {
    try {
      // Check if paused (global or per-session)
      const globalPaused = await fs.access(CONFIG.pauseFile).then(() => true).catch(() => false);
      const loopInfo = sessionLoops.get(session);
      if (globalPaused || (loopInfo && loopInfo.paused)) return;
      
      // Check if schedule is enabled and if we're in active hours
      if (config.scheduleEnabled) {
        const scheduleActive = isScheduleActive(session);
        if (!scheduleActive) {
          console.log(`Session ${session}: Outside scheduled hours, skipping`);
          return;
        }
      }
      
      // Get the best conditional message for this session
      const message = await getConditionalMessage(session) || config.customMessage;
      
      console.log(`Loop iteration for ${session}: message="${message}"`);
      
      // Only send if we have a message
      if (message) {
        // Send message to the specific session
        await sendCustomMessage(message, session);
        console.log(`Sent message to ${session}: ${message}`);
      } else {
        console.log(`No message to send for ${session}`);
      }
      
      // Update next message time
      const loopInfoUpdate = sessionLoops.get(session);
      if (loopInfoUpdate) {
        loopInfoUpdate.nextMessageTime = new Date(Date.now() + config.delayMinutes * 60 * 1000);
      }
      
    } catch (error) {
      console.error('Loop error for session ' + session + ':', error);
    }
  }, config.delayMinutes * 60 * 1000); // Convert minutes to milliseconds
  
  // Store loop info
  sessionLoops.set(session, {
    intervalId: loopInterval,
    startTime: new Date(),
    nextMessageTime: firstMessageTime,
    delayMinutes: config.delayMinutes,
    paused: false
  });
  
  // Save to file for persistence
  await saveActiveLoops();
  
  console.log('Started loop for session: ' + session);
}

async function stopLoop(session = null) {
  try {
    if (session) {
      // Stop specific session loop
      const loopInfo = sessionLoops.get(session);
      if (loopInfo && loopInfo.intervalId) {
        clearInterval(loopInfo.intervalId);
        sessionLoops.delete(session);
        console.log('Stopped loop for session: ' + session);
      }
      
      // Also run the stop script to clean up lock files
      try {
        await execAsync(`/home/michael/InfiniQuest/tmp/claudeLoop/stop-claude-loop.sh ${session}`);
        console.log('Cleaned up lock files for session: ' + session);
      } catch (e) {
        console.error('Failed to run stop script:', e);
      }
    } else {
      // Stop all session loops
      if (sessionLoops && sessionLoops.size > 0) {
        for (const [sess, loopInfo] of sessionLoops.entries()) {
          if (loopInfo && loopInfo.intervalId) {
            clearInterval(loopInfo.intervalId);
          }
        }
        sessionLoops.clear();
      }
      console.log('Stopped all loops');
    }
    
    // Update the persistent file
    await saveActiveLoops();
    
    // Also clean up old pid file if exists
    try {
      await fs.unlink(CONFIG.loopPidFile).catch(() => {});
    } catch (e) {
      // Ignore
    }
  } catch (error) {
    console.error('Error in stopLoop:', error);
  }
}

async function pauseLoop() {
  // Save the current state of all loops including time remaining
  const pauseState = {
    pausedAt: new Date().toISOString(),
    loops: {}
  };
  
  for (const [session, loopInfo] of sessionLoops.entries()) {
    if (loopInfo && loopInfo.intervalId && loopInfo.nextMessageTime) {
      const timeRemaining = loopInfo.nextMessageTime - Date.now();
      pauseState.loops[session] = {
        timeRemaining: Math.max(0, timeRemaining)
      };
    }
  }
  
  await fs.writeFile(CONFIG.pauseFile, JSON.stringify(pauseState, null, 2));
}

async function resumeLoop() {
  try {
    // Read pause state to restore timers
    const pauseData = await fs.readFile(CONFIG.pauseFile, 'utf-8');
    const pauseState = JSON.parse(pauseData);
    
    // Restore timer for each paused loop
    for (const [session, pauseInfo] of Object.entries(pauseState.loops)) {
      const loopInfo = sessionLoops.get(session);
      if (loopInfo && pauseInfo.timeRemaining > 0) {
        // Restore the next message time based on remaining time
        loopInfo.nextMessageTime = new Date(Date.now() + pauseInfo.timeRemaining);
      }
    }
  } catch (error) {
    console.log('No pause state to restore');
  }
  
  await fs.unlink(CONFIG.pauseFile).catch(() => {});
}

async function getPauseStatus() {
  try {
    const isPaused = await fs.access(CONFIG.pauseFile).then(() => true).catch(() => false);
    
    if (isPaused) {
      try {
        // Try to read the pause state
        const pauseData = await fs.readFile(CONFIG.pauseFile, 'utf-8');
        const pauseState = JSON.parse(pauseData);
        
        return {
          paused: true,
          pausedAt: pauseState.pausedAt,
          loops: pauseState.loops
        };
      } catch (e) {
        // Old format or corrupted file - check for resume time file
        try {
          const resumeTimeContent = await fs.readFile(CONFIG.resumeTimeFile, 'utf-8');
          return {
            paused: true,
            resumeTime: resumeTimeContent.trim()
          };
        } catch (e2) {
          return { paused: true, resumeTime: null };
        }
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
    exec('nohup "' + autoResumeScript + '" > /tmp/claude-auto-resume.log 2>&1 &');
    return true;
  } catch (error) {
    console.error('Failed to start auto-resume:', error);
    throw error;
  }
}

async function sendCustomMessage(message, session = 'claude') {
  // Use our safe middleware script to handle all special characters properly
  const scriptPath = path.join(__dirname, 'tmux-send-safe.sh');
  
  try {
    // Use spawn to pipe the message via stdin, avoiding all shell escaping issues
    const { spawn } = require('child_process');
    
    return new Promise((resolve, reject) => {
      const proc = spawn(scriptPath, [session]);
      let stdout = '';
      let stderr = '';
      
      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      proc.on('close', (code) => {
        if (code !== 0) {
          const error = new Error(`tmux-send-safe.sh exited with code ${code}`);
          error.stderr = stderr;
          reject(error);
        } else {
          console.log('Message sent:', stdout.trim() || 'Success');
          if (stderr) {
            console.warn('Tmux send warning:', stderr);
          }
          // Track the message for session matching
          sessionMatcher.recordLoopMessage(session, message);
          resolve();
        }
      });
      
      proc.on('error', (err) => {
        reject(err);
      });
      
      // Write the message to stdin and close it
      proc.stdin.write(message);
      proc.stdin.end();
    });
  } catch (error) {
    console.error('Failed to send message to tmux:', error);
    throw error;
  }
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
    .button-info { background: var(--info); color: white; }
    
    .mode-button {
      transition: all 0.2s;
    }
    
    .mode-button:hover {
      background: var(--bg-tertiary) !important;
    }
    
    .mode-button.active {
      background: var(--accent) !important;
      color: #000 !important;
      font-weight: 600;
    }
    
    .vk-button:hover {
      background: var(--bg-tertiary) !important;
      transform: translateY(-1px);
    }
    
    .vk-button:active {
      transform: translateY(0);
    }
    
    .conversation-item:hover {
      background: var(--bg-secondary) !important;
    }
    
    .conversation-item.active:hover {
      background: var(--bg-secondary) !important;
    }
    
    .project-group {
      margin-bottom: 10px;
      border: 1px solid var(--bg-tertiary);
      border-radius: 6px;
      overflow: hidden;
    }
    
    .project-header {
      padding: 10px;
      background: var(--bg-secondary);
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      transition: background 0.2s;
    }
    
    .project-header:hover {
      background: var(--bg-tertiary);
    }
    
    .project-header.current-project {
      background: linear-gradient(135deg, var(--primary), var(--primary-hover));
      color: white;
      border: 2px solid var(--primary);
      box-shadow: 0 2px 8px rgba(74, 144, 226, 0.3);
      font-weight: bold;
    }
    
    .project-header.current-project:hover {
      background: linear-gradient(135deg, var(--primary-hover), var(--primary));
      box-shadow: 0 2px 10px rgba(74, 144, 226, 0.4);
    }
    
    .project-conversations {
      padding: 5px;
      background: var(--bg-primary);
    }
    
    .project-conversations.collapsed {
      display: none;
    }
    
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
      position: relative;
    }
    
    .context-percentage {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      color: var(--text-primary);
      font-weight: bold;
      text-shadow: 0 0 3px rgba(0,0,0,0.5), 0 0 6px rgba(0,0,0,0.3);
      z-index: 1;
      pointer-events: none;
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
      position: relative;
      background: linear-gradient(90deg, var(--success), #8BC34A);
      transition: width 0.3s ease;
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
    
    /* Toggle Switch Styles */
    .toggle-switch {
      position: relative;
      display: inline-block;
      width: 44px;
      height: 24px;
    }
    
    .toggle-switch input {
      opacity: 0;
      width: 0;
      height: 0;
    }
    
    .toggle-slider {
      position: absolute;
      cursor: pointer;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: linear-gradient(to right, var(--primary) 50%, var(--bg-secondary) 50%);
      transition: .3s;
      border-radius: 24px;
      border: 1px solid var(--border);
    }
    
    .toggle-slider:before {
      position: absolute;
      content: "";
      height: 18px;
      width: 18px;
      left: 3px;
      bottom: 3px;
      background-color: white;
      transition: .3s;
      border-radius: 50%;
      box-shadow: 0 2px 4px rgba(0,0,0,0.2);
    }
    
    input:checked + .toggle-slider {
      background: linear-gradient(to right, var(--bg-secondary) 50%, var(--primary) 50%);
    }
    
    input:checked + .toggle-slider:before {
      transform: translateX(20px);
    }
    
    @media (max-width: 1200px) {
      .grid {
        grid-template-columns: 1fr;
      }
    }
    
    /* Auto-resize textareas */
    textarea.auto-resize {
      min-height: 60px;
      resize: vertical;
      overflow: hidden;
      width: 100%;
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
          <div class="compact-context-fill" id="compact-context-fill" style="width: 100%"></div>
          <div class="context-percentage" id="compact-context-percentage">100%</div>
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
        <span style="margin: 0 10px; color: var(--text-secondary);">|</span>
        <button id="stop-all-loops-btn" class="compact-button button-warning" onclick="stopAllLoops()">
          ⏸️ Stop All Loops
        </button>
        <button id="stop-all-sessions-btn" class="compact-button button-danger" onclick="stopAllSessions()">
          🛑 Stop All Sessions
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
          <label>Custom Loop Name (optional)</label>
          <input type="text" id="custom-name" placeholder="e.g., AI Dev Review, Main Project" maxlength="50">
          <div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">
            Display name for this loop (technical name remains the same)
          </div>
        </div>
        
        <div class="control-group">
          <label>Delay Between Messages (minutes)</label>
          <input type="number" id="delay-minutes" min="1" max="60" value="10">
        </div>
        
        <div class="checkbox-group">
          <label>
            <input type="checkbox" id="start-with-delay">
            Start with delay when loop starts
          </label>
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
        
        <div class="control-group" id="context-settings" style="display: none;">
          <!-- Context thresholds removed - using hardcoded values for visual indicators only -->
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
        
        <div class="checkbox-group" style="margin-bottom: 15px;">
          <label>
            <input type="checkbox" id="auto-finish-enabled" onchange="updateConditionalConfig()">
            🏁 Auto-Pause on "Finished everything for now!"
          </label>
          <div style="font-size: 11px; color: var(--text-secondary); margin-left: 20px; margin-top: 5px;">
            Automatically pauses the loop when Claude indicates all todos are complete
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
                <label style="cursor: pointer;">
                  <input type="checkbox" id="morning-enabled" onchange="updateConditionalConfig()">
                  <span id="morning-arrow" style="display: inline-block; width: 12px;">▶</span>
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
                <textarea id="morning-message" class="auto-resize"></textarea>
              </div>
            </div>
            
            <div class="control-group" style="background: var(--bg-tertiary); padding: 15px; border-radius: 6px; margin-bottom: 10px;">
              <div class="checkbox-group">
                <label style="cursor: pointer;">
                  <input type="checkbox" id="afternoon-enabled" onchange="updateConditionalConfig()">
                  <span id="afternoon-arrow" style="display: inline-block; width: 12px;">▶</span>
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
                <textarea id="afternoon-message" class="auto-resize"></textarea>
              </div>
            </div>
            
            <div class="control-group" style="background: var(--bg-tertiary); padding: 15px; border-radius: 6px; margin-bottom: 10px;">
              <div class="checkbox-group">
                <label style="cursor: pointer;">
                  <input type="checkbox" id="evening-enabled" onchange="updateConditionalConfig()">
                  <span id="evening-arrow" style="display: inline-block; width: 12px;">▶</span>
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
                <textarea id="evening-message" class="auto-resize"></textarea>
              </div>
            </div>
            
            <div class="control-group" style="background: var(--bg-tertiary); padding: 15px; border-radius: 6px; margin-bottom: 10px;">
              <div class="checkbox-group">
                <label style="cursor: pointer;">
                  <input type="checkbox" id="standard-enabled" onchange="updateConditionalConfig()">
                  <span id="standard-arrow" style="display: inline-block; width: 12px;">▶</span>
                  Standard Message (all other times)
                </label>
              </div>
              <div id="standard-settings" style="display: none; margin-left: 20px;">
                <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 5px;">
                  This message will be used when no time-specific messages apply
                </div>
                <textarea id="standard-message" class="auto-resize" placeholder="Please continue with the current task..."></textarea>
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
                <textarea id="low-context-message" class="auto-resize" style="margin-top: 5px;"></textarea>
                
                <div class="checkbox-group" style="margin-top: 10px;">
                  <label>
                    <input type="checkbox" id="auto-compact-enabled" onchange="updateConditionalConfig()">
                    Enable Auto-Compact (adds instruction for Claude to say "Let's compact!")
                  </label>
                  <label style="display: block; margin-top: 8px;">
                    <input type="checkbox" id="auto-finish-enabled" onchange="updateConditionalConfig()">
                    Enable Auto-Finish (adds instruction for Claude to say "Finished everything for now!")
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
                <textarea id="after-compact-message" class="auto-resize" style="margin-top: 5px;"></textarea>
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
            <label style="margin-right: 10px; font-size: 14px;">Tmux Session:</label>
            <select id="session-select" onchange="updateSelectedSession()" style="padding: 6px 10px; border-radius: 4px; background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--bg-tertiary); font-size: 14px;">
              <!-- Options populated dynamically -->
            </select>
            <button id="new-session-btn" style="padding: 6px 12px; background: var(--primary); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px;">+ New Session</button>
            <button id="kill-tmux-btn" onclick="killTmuxSession()" style="padding: 6px 12px; background: var(--error); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; margin-left: 5px;">🗑️ Kill <span id="kill-tmux-session-name">tmux</span></button>
          </div>
          <div style="width: 1px; height: 30px; background: var(--bg-tertiary); margin: 0 20px;"></div>
          <div id="monitor-status" style="display: flex; align-items: center; gap: 12px;">
            <span style="font-size: 14px; color: var(--text-secondary);">Logging Status:</span>
            <span id="monitor-status-text" style="font-size: 14px; margin-right: 10px;">Checking...</span>
            <button class="compact-button button-success" onclick="controlLogMonitor('start')" style="padding: 6px 10px; font-size: 13px;">
              📝 Start
            </button>
            <button class="compact-button button-danger" onclick="controlLogMonitor('stop')" style="padding: 6px 10px; font-size: 13px;">
              🛑 Stop
            </button>
            <div style="margin-left: 15px; display: flex; align-items: center; gap: 8px;">
              <span style="font-size: 12px; color: var(--text-secondary);">SH</span>
              <label class="toggle-switch" title="Toggle between SH and JS monitor">
                <input type="checkbox" id="monitor-type-toggle" onchange="toggleMonitorType()">
                <span class="toggle-slider"></span>
              </label>
              <span style="font-size: 12px; color: var(--text-secondary);">JS</span>
            </div>
            <div style="margin-left: 20px; display: flex; align-items: center; gap: 8px;">
              <span style="font-size: 14px; color: var(--text-secondary);">Message Monitor:</span>
              <span id="message-monitor-status" style="font-size: 14px;">Checking...</span>
            </div>
          </div>
        </div>
        
        <!-- Working Directory and Session Controls -->
        <div style="margin-bottom: 15px; padding: 10px; background: var(--bg-tertiary); border-radius: 6px;">
          <div style="display: flex; align-items: center; gap: 15px; margin-bottom: 10px;">
            <div style="flex: 1;">
              <label style="font-size: 12px; color: var(--text-secondary); display: block; margin-bottom: 5px;">Working Directory:</label>
              <div style="display: flex; gap: 5px;">
                <input type="text" id="working-directory" placeholder="' + HOME_DIR + '" value="" style="flex: 1; padding: 6px 10px; background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--bg-tertiary); border-radius: 4px;">
                <button onclick="browseDirectory()" style="padding: 6px 12px; background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--bg-tertiary); border-radius: 4px; cursor: pointer;" title="Browse directories">📁</button>
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: 10px;">
              <span style="font-size: 14px; color: var(--text-primary); font-weight: bold; margin-right: 5px;">Claude:</span>
              <button id="stop-claude-btn" class="button button-danger" onclick="stopClaude()" style="padding: 8px 16px; font-size: 13px;">
                ⏹️ Stop
              </button>
              <button id="new-claude-btn" class="button button-success" onclick="restartSession()" style="padding: 8px 16px; font-size: 13px;" title="Start new Claude session in current directory">
                🆕 New Session
              </button>
              <button id="resume-claude-btn" class="button button-success" onclick="restartAndResumeSession()" style="padding: 8px 16px; font-size: 13px;" title="Resume most recent Claude conversation">
                ↻ Resume Recent
              </button>
            </div>
          </div>
        </div>
        
        <!-- Conversation Management -->
        <div id="conversation-manager" style="margin-bottom: 15px; padding: 10px; background: var(--bg-tertiary); border-radius: 6px; display: none;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <h4 style="margin: 0; font-size: 14px;">Conversation Management</h4>
            <button onclick="toggleConversationManager()" class="button button-small" style="padding: 4px 8px; font-size: 11px;">
              ✕ Close
            </button>
          </div>
          <div style="margin-bottom: 10px;">
            <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 5px;">
              Current conversation: <span id="current-conversation-id" style="font-family: monospace;">Unknown</span>
            </div>
            <div style="display: flex; gap: 10px; align-items: center;">
              <button onclick="window.refreshConversationList(true)" class="button button-small" style="padding: 4px 12px; font-size: 12px;" title="Refresh and scan for new conversations">
                🔄 Refresh List
              </button>
              <label style="font-size: 12px; display: flex; align-items: center; gap: 5px;">
                <input type="checkbox" id="group-by-project" checked onchange="window.refreshConversationList()">
                Group by project
              </label>
              <label style="font-size: 12px; display: flex; align-items: center; gap: 5px;">
                <input type="checkbox" id="show-tree-view" onchange="window.refreshConversationList()">
                Tree view
              </label>
              <button onclick="window.scanConversationTree(true)" class="button button-small" style="padding: 4px 12px; font-size: 12px;" title="Force full rescan">
                🔍 Rescan
              </button>
            </div>
          </div>
          <div id="conversation-list" style="max-height: 400px; overflow-y: auto; border: 1px solid var(--bg-secondary); border-radius: 4px; padding: 5px;">
            <div style="text-align: center; color: var(--text-secondary); padding: 20px;">
              Click "Refresh List" to load conversations
            </div>
          </div>
        </div>
        
        <!-- Toggle button for conversation manager -->
        <div style="margin-bottom: 10px;">
          <button onclick="toggleConversationManager()" class="button button-small button-info" style="padding: 6px 12px; font-size: 12px;">
            📝 Manage Conversations
          </button>
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
        <div class="log-viewer" id="logs" style="cursor: text; transition: border 0.2s;">
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
            onkeydown="handleMessageKeyDown(event)"
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
        
        <!-- Virtual Keyboard -->
        <div style="
          margin-top: 10px;
          padding-top: 10px;
          border-top: 1px solid var(--border);
        ">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <!-- Mode Toggle on the left -->
            <button id="mode-toggle" class="button button-primary" onclick="toggleMode()" style="padding: 6px 16px; font-size: 12px; margin-right: 10px;">
              🔄 Toggle Mode (Shift+Tab)
            </button>
            <div>
              <span style="font-size: 12px; color: var(--text-secondary);">Virtual Keyboard</span>
              <span style="font-size: 11px; opacity: 0.8;">(Click log area to enable shortcuts: Esc, Tab, Arrow keys, Ctrl+D/Z/Enter)</span>
            </div>
          </div>
          <div style="display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; align-items: flex-start;">
            <!-- Left side keys -->
            <div style="display: flex; gap: 5px; flex-wrap: wrap;">
              <button class="vk-button" onclick="sendKey('Escape')" style="padding: 8px 16px; background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border); border-radius: 4px; cursor: pointer;" title="Press Esc key">Esc</button>
              <button class="vk-button" onclick="sendKey('Tab')" style="padding: 8px 16px; background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border); border-radius: 4px; cursor: pointer;" title="Press Tab key">Tab</button>
              <button class="vk-button" onclick="sendKey('C-c')" style="padding: 8px 16px; background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border); border-radius: 4px; cursor: pointer;" title="Press Ctrl+C">Ctrl+C</button>
              <button class="vk-button" onclick="sendKey('C-d')" style="padding: 8px 16px; background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border); border-radius: 4px; cursor: pointer;" title="Press Ctrl+D">Ctrl+D</button>
              <button class="vk-button" onclick="sendKey('C-z')" style="padding: 8px 16px; background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border); border-radius: 4px; cursor: pointer;" title="Press Ctrl+Z">Ctrl+Z</button>
            </div>
            <!-- Enter key -->
            <button class="vk-button" onclick="sendKey('Enter')" style="padding: 8px 24px; background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border); border-radius: 4px; cursor: pointer; font-weight: 600;" title="Press Ctrl+Enter">Enter</button>
            <!-- Arrow keys -->
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; width: 120px;">
              <div></div>
              <button class="vk-button" onclick="sendKey('Up')" style="padding: 8px; background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border); border-radius: 4px; cursor: pointer;" title="Press Up arrow">↑</button>
              <div></div>
              <button class="vk-button" onclick="sendKey('Left')" style="padding: 8px; background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border); border-radius: 4px; cursor: pointer;" title="Press Left arrow">←</button>
              <button class="vk-button" onclick="sendKey('Down')" style="padding: 8px; background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border); border-radius: 4px; cursor: pointer;" title="Press Down arrow">↓</button>
              <button class="vk-button" onclick="sendKey('Right')" style="padding: 8px; background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border); border-radius: 4px; cursor: pointer;" title="Press Right arrow">→</button>
            </div>
          </div>
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
    // Context thresholds (hardcoded for visual indicators)
    const contextWarningPercent = 20;
    const contextCriticalPercent = 10;
    
    let statusInterval;
    let logInterval;
    let currentConfig = {};
    let scheduleMinutes = new Array(1440).fill(true); // Track schedule state at minute level
    let loopConfig = {}; // Will be loaded from server
    let sessionConfigs = {}; // Store configs per session
    
    // Global variables for session management
    let currentSession = null; // Will be set from dropdown
    let availableSessions = [];
    let isMonitorRunning = false;
    let isMonitorTransitioning = false; // Track if monitor is starting/stopping
    let lastCompactTime = 0; // Track when we last sent a compact command
    let lastAutoPauseTime = 0; // Track when we last auto-paused
    let lastMessageSentTime = 0; // Track when we last sent any message to tmux
    let currentLogRefreshRate = 10; // Default 10 seconds
    let isSwitchingSessions = false; // Prevent saves during session switch
    let isLoopRunningAndNotPaused = false; // Track if loop is running and not paused
    let saveTimeout = null; // Global save timeout
    window.saveTimeout = null; // Also store on window for access from updateSelectedSession
    
    // Global functions that need to be accessible from HTML
    
    // Find the next available claude-loop session number
    function getNextAvailableSessionName() {
      const existingNumbers = availableSessions
        .filter(s => s.startsWith('claude-loop'))
        .map(s => {
          const match = s.match(/claude-loop(\d+)/);
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
      
      // Reset monitor states when switching sessions
      isMonitorTransitioning = false;
      isMonitorRunning = false;
      
      // Update page title
      document.title = 'Claude Loop Dashboard - ' + currentSession;
      
      // Update kill button text
      const killBtnText = document.getElementById('kill-tmux-session-name');
      if (killBtnText) {
        killBtnText.textContent = currentSession;
      }
      
      // Update the display to reflect the new session
      updateMonitorStatus();
      updateLogs();
    }
    
    // Forward declarations for functions defined later
    let loadTmuxSessions, updateMonitorStatus, updateLogs;
    
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
    
    // Toggle monitor type
    async function toggleMonitorType() {
      const toggle = document.getElementById('monitor-type-toggle');
      const monitorType = toggle.checked ? 'js' : 'sh';
      try {
        await fetch('/api/monitor-type', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: monitorType })
        });
        console.log('[Monitor] Type preference saved:', monitorType);
      } catch (error) {
        console.error('[Monitor] Failed to save type preference:', error);
      }
    }
    
    // Save monitor type preference (called before starting)
    async function saveMonitorType() {
      const toggle = document.getElementById('monitor-type-toggle');
      const monitorType = toggle.checked ? 'js' : 'sh';
      try {
        await fetch('/api/monitor-type', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: monitorType })
        });
        console.log('[Monitor] Type preference saved:', monitorType);
      } catch (error) {
        console.error('[Monitor] Failed to save type preference:', error);
      }
    }

    // Control log monitor separately
    async function controlLogMonitor(action) {
      // Save monitor type preference before starting
      if (action === 'start') {
        await saveMonitorType();
      }
      
      // Prevent multiple simultaneous transitions
      if (isMonitorTransitioning) {
        console.log('[Log Monitor] Already transitioning, ignoring request');
        return;
      }
      
      try {
        isMonitorTransitioning = true;
        
        if (!currentSession) {
          console.error('No session selected');
          return;
        }
        const payload = { 
          action, 
          instance: currentSession,  // Use session name as instance
          session: currentSession
        };
        
        // Show immediate feedback for start action
        if (action === 'start') {
          // Force clear any stale state
          isMonitorRunning = false;
          
          const logsEl = document.getElementById('logs');
          logsEl.innerHTML = '<span style="color: var(--success);">🔄 Starting log monitor for ' + currentSession + '...</span>';
          const statusText = document.getElementById('monitor-status-text');
          statusText.innerHTML = '<span style="color: var(--warning);">⏳ Starting...</span>';
          
          // Try to ensure clean state - ignore errors since stop might fail if nothing running
          try {
            // First check if a monitor is already running
            const statusResponse = await fetch('/api/log-monitor/status?instance=' + encodeURIComponent(currentSession));
            const statusData = await statusResponse.json();
            
            if (statusData.running) {
              console.log('[Log Monitor] Monitor already running, attempting to stop first');
              // Try to stop it
              await fetch('/api/log-monitor', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                  action: 'stop', 
                  instance: currentSession,
                  session: currentSession
                })
              });
              // Wait for stop to complete
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          } catch (e) {
            // Ignore errors during cleanup
            console.log('[Log Monitor] Cleanup check completed');
          }
          
          // Also force an immediate status check to help the interval
          setTimeout(() => {
            updateMonitorStatus();
            // Reset the counter so we check more frequently after starting
            if (window.monitorStatusCheckCounter !== undefined) {
              window.monitorStatusCheckCounter = 0;
            }
          }, 100);
        } else if (action === 'stop') {
          // Clear state immediately for stop
          isMonitorRunning = false;
          const logsEl = document.getElementById('logs');
          logsEl.innerHTML = '<span style="color: var(--text-secondary);">Stopping monitor...</span>';
          
          // Clear the stopping message after a short delay
          setTimeout(() => {
            const logsEl = document.getElementById('logs');
            if (logsEl && logsEl.innerHTML.includes('Stopping monitor')) {
              logsEl.innerHTML = '<span style="color: var(--text-secondary);">No active monitor - Click "Start Console Logging" to begin</span>';
            }
          }, 1000);
        }
        
        const response = await fetch('/api/log-monitor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        
        if (!response.ok) {
          const result = await response.json();
          console.error('[Log Monitor] API Error:', result);
          
          // Clear the starting message on error
          const logsEl = document.getElementById('logs');
          if (logsEl) {
            logsEl.innerHTML = '<span style="color: var(--danger);">❌ Failed to start monitor: ' + (result.message || 'Unknown error') + '</span>';
          }
          
          // Reset states on error
          isMonitorRunning = false;
          isMonitorTransitioning = false;
          
          if (result.message) {
            alert('Failed to start monitor: ' + result.message);
          }
          return;
        }
        
        // For start action, use longer delay and force refresh
        if (action === 'start') {
          // Clear any existing timeouts/intervals to prevent conflicts
          if (logInterval) {
            clearInterval(logInterval);
          }
          
          // First update after 1 second
          setTimeout(async () => {
            console.log('[Log Monitor] First update check - isMonitorRunning:', isMonitorRunning);
            await updateMonitorStatus();
            // Force set running state and update logs
            console.log('[Log Monitor] Forcing monitor state to running');
            isMonitorRunning = true;
            
            // Force clear any stuck message and update logs
            console.log('[Log Monitor] Forcing log update after start');
            const logsEl = document.getElementById('logs');
            if (logsEl && (logsEl.innerHTML.includes('Starting log monitor') || logsEl.innerHTML.includes('No active monitor'))) {
              logsEl.innerHTML = '<span style="color: var(--text-secondary);">Loading logs...</span>';
            }
            
            // Force an immediate log fetch
            try {
              const response = await fetch('/api/logs?maxLines=' + currentLogLines + '&session=' + currentSession);
              const data = await response.json();
              if (data.logs && data.logs.length > 0) {
                // Directly update the display
                const lines = data.logs.split('\\n');
                const formattedLines = lines.map(line => convertAnsiToHtml(line));
                // Wrap content to prevent over-scrolling
          logsEl.innerHTML = '<div style="padding-bottom: 20px;">' + formattedLines.join('<br>') + '</div>';
              }
            } catch (e) {
              console.error('[Log Monitor] Direct fetch error:', e);
            }
            
            await updateLogs();
            // Scroll to bottom on first load
            setTimeout(() => {
              const logsEl = document.getElementById('logs');
              if (logsEl) {
                logsEl.scrollTop = logsEl.scrollHeight;
              }
            }, 100);
          }, 1000);
          
          // Second update after 2 seconds and restart interval
          setTimeout(async () => {
            console.log('[Log Monitor] Second update - restarting interval');
            await updateMonitorStatus();
            await updateLogs();
            // Ensure we're scrolled to bottom after second load
            setTimeout(() => {
              const logsEl = document.getElementById('logs');
              if (logsEl) {
                logsEl.scrollTop = logsEl.scrollHeight;
              }
            }, 100);
            
            // Clear any existing interval before creating new one
            if (logInterval) {
              clearInterval(logInterval);
              console.log('[Log Monitor] Cleared old interval');
            }
            
            // Restart the interval with fresh state
            logInterval = setInterval(async () => {
              // Only update if monitor is running or transitioning
              if (isMonitorRunning || isMonitorTransitioning) {
                await updateLogs();
              }
            }, currentLogRefreshRate * 1000);
            
            console.log('[Log Monitor] Started fresh interval with rate:', currentLogRefreshRate, 'seconds');
            isMonitorTransitioning = false;
            window.transitionStartTime = null;
          }, 2000);
        } else {
          // For stop action, clear interval and update immediately
          if (logInterval) {
            clearInterval(logInterval);
            console.log('[Log Monitor] Cleared interval on stop');
          }
          
          setTimeout(async () => {
            isMonitorRunning = false;
            await updateMonitorStatus();
            // Force clear the logs display on stop
            const logsEl = document.getElementById('logs');
            if (logsEl) {
              logsEl.innerHTML = '<span style="color: var(--text-secondary);">No active monitor - Click "Start Console Logging" to begin</span>';
            }
            isMonitorTransitioning = false;
            window.transitionStartTime = null;
            console.log('[Log Monitor] Stop complete, transition cleared');
          }, 500);
        }
      } catch (error) {
        console.error('Log monitor control error:', error);
        alert('Failed to control log monitor: ' + error.message);
        isMonitorTransitioning = false;
      }
    }

    // Stop all loops function
    async function stopAllLoops() {
      try {
        if (!confirm('Stop all running loops across all sessions?\\n\\nThis will stop the automation but keep Claude sessions alive.')) {
          return;
        }
        
        // Show status
        const statusText = document.getElementById('status-text');
        if (statusText) {
          statusText.textContent = 'Stopping all loops...';
        }
        
        // Call API to stop all loops
        const response = await fetch('/api/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            action: 'stop-all-loops'
          })
        });
        
        if (!response.ok) {
          throw new Error('Failed to stop all loops');
        }
        
        // Update UI after a delay
        setTimeout(() => {
          updateLoopStatus();
        }, 1000);
        
      } catch (error) {
        console.error('Failed to stop all loops:', error);
        alert('Error stopping all loops: ' + error.message);
        // Try to update status anyway
        updateLoopStatus();
      }
    }
    
    // Stop all Claude sessions function
    async function stopAllSessions() {
      try {
        if (!confirm('Stop all Claude sessions?\\n\\nThis will TERMINATE all tmux sessions running Claude, losing any ongoing conversations.\\n\\nAre you sure?')) {
          return;
        }
        
        // Show status
        const statusText = document.getElementById('status-text');
        if (statusText) {
          statusText.textContent = 'Stopping all Claude sessions...';
        }
        
        // Call API to stop all sessions
        const response = await fetch('/api/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            action: 'stop-all-sessions'
          })
        });
        
        if (!response.ok) {
          throw new Error('Failed to stop all sessions');
        }
        
        // Update UI after a delay
        setTimeout(() => {
          updateLoopStatus();
          updateGrid();
          if (statusText) {
            statusText.textContent = 'All Claude sessions terminated';
          }
        }, 2000);
      } catch (error) {
        console.error('Stop all sessions error:', error);
        alert('Failed to stop all sessions: ' + error.message);
      }
    }
    
    // Control loop function - needs to be global for onclick handlers
    async function controlLoop(action) {
      try {
        // Get the current selected session
        const currentSession = document.getElementById('session-select').value || 'claude';
        
        // If starting, ensure tmux session exists first
        if (action === 'start') {
          const tmuxResponse = await fetch('/api/tmux-setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session: currentSession, action: 'ensure' })
          });
          
          if (!tmuxResponse.ok) {
            console.error('Failed to ensure tmux session');
            return;
          }
          
          // Small delay to ensure tmux is ready
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        // Get session-specific config or use global config as fallback
        const sessionConfig = sessionConfigs[currentSession] || loopConfig;
        
        // Pass the session info with the control action
        await fetch('/api/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            action,
            session: currentSession,
            config: sessionConfig // Include the session-specific configuration
          })
        });
        
        // Update UI status after action
        setTimeout(() => {
          updateLoopStatus();
        }, 500);
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
        console.warn('Element not found: ' + id);
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
    
    // REMOVED duplicate loadConfig function - using loadInitialConfig and loadSessionConfig instead
    
    async function saveConfig() {
      // Don't save if we're in the middle of switching sessions
      if (isSwitchingSessions) {
        console.log('Skipping save - switching sessions');
        return;
      }
      
      updateSaveStatus('saving');
      
      const config = {
        customName: getElementValue('custom-name', 'value', ''),
        workingDirectory: getElementValue('working-directory', 'value', ''),
        delayMinutes: parseInt(getElementValue('delay-minutes', 'value', '10')),
        startWithDelay: getElementValue('start-with-delay', 'checked', true),
        contextAware: getElementValue('context-aware', 'checked', true),
        useStartTime: getElementValue('use-start-time', 'checked', false),
        startTime: getElementValue('start-time', 'value', '09:00'),
        customMessage: getElementValue('custom-message', 'value', ''),
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
          standardMessage: {
            enabled: getElementValue('standard-enabled', 'checked', false),
            message: getElementValue('standard-message', 'value', '')
          },
          lowContextMessage: {
            enabled: getElementValue('low-context-enabled', 'checked', false),
            threshold: parseInt(getElementValue('low-context-threshold', 'value', '30')),
            message: getElementValue('low-context-message', 'value', ''),
            autoCompact: getElementValue('auto-compact-enabled', 'checked', false),
            autoFinish: getElementValue('auto-finish-enabled', 'checked', false)
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
      
      // Store config in global variable for use by controlLoop
      loopConfig = config;
      // Also store for current session
      sessionConfigs[currentSession] = config;
      // Update currentConfig for auto-compact checking
      currentConfig = config;
      
      try {
        const response = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            config,
            session: currentSession // Save per session
          })
        });
        
        if (!response.ok) {
          throw new Error('HTTP error! status: ' + response.status);
        }
        
        console.log('Config saved successfully');
        updateSaveStatus('saved');
        
        // Update the dropdown to reflect any custom name changes
        await updateSessionDropdown();
      } catch (error) {
        console.error('Failed to save config:', error);
        updateSaveStatus('error');
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
              autoResumeSpan.textContent = 'active (' + hours + 'h ' + minutes + 'm remaining)';
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
        const response = await fetch('/api/context?session=' + encodeURIComponent(currentSession));
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
          
          // Update color based on percentage
          fill.className = 'context-fill';
          if (percent <= contextCriticalPercent) {
            fill.classList.add('context-critical');
          } else if (percent <= contextWarningPercent) {
            fill.classList.add('context-warning');
          }
          
          // Update percentage text if it exists
          const contextPercentage = document.getElementById('context-percentage');
          if (contextPercentage) {
            contextPercentage.textContent = percent + '%';
          }
        }
        
        // Update compact horizontal context meter
        if (compactFill) {
          compactFill.style.width = percent + '%';
          
          compactFill.className = 'compact-context-fill';
          if (percent <= contextCriticalPercent) {
            compactFill.classList.add('context-critical');
          } else if (percent <= contextWarningPercent) {
            compactFill.classList.add('context-warning');
          }
        }
        
        // Update compact percentage text
        const compactPercentage = document.getElementById('compact-context-percentage');
        if (compactPercentage) {
          compactPercentage.textContent = percent + '%';
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
        
        // Load configs for all sessions to get custom names
        for (const session of availableSessions) {
          try {
            const configResponse = await fetch('/api/config?session=' + encodeURIComponent(session));
            if (configResponse.ok) {
              const config = await configResponse.json();
              sessionConfigs[session] = config;
            }
          } catch (err) {
            console.log('Could not load config for session:', session);
          }
        }
        
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
          
          // Check if this session has a custom name
          const sessionConfig = sessionConfigs[session];
          if (sessionConfig && sessionConfig.customName) {
            option.textContent = sessionConfig.customName + ' (' + session + ')';
          } else {
            option.textContent = session;
          }
          
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
        
        // Try to restore the previously selected session from localStorage
        try {
          const savedSession = localStorage.getItem('claude-loop-selected-session');
          if (savedSession && availableSessions.includes(savedSession)) {
            currentSession = savedSession;
          }
        } catch (e) {
          console.error('Failed to restore session preference:', e);
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
      // Set flag to prevent saves during switch
      isSwitchingSessions = true;
      
      // Cancel any pending saves
      if (window.saveTimeout) {
        clearTimeout(window.saveTimeout);
        window.saveTimeout = null;
      }
      
      const select = document.getElementById('session-select');
      currentSession = select.value;
      
      // Save the selected session to localStorage
      try {
        localStorage.setItem('claude-loop-selected-session', currentSession);
      } catch (e) {
        console.error('Failed to save session preference:', e);
      }
      
      // Update page title
      document.title = 'Claude Loop Dashboard - ' + currentSession;
      
      // Update kill button text
      const killBtnText = document.getElementById('kill-tmux-session-name');
      if (killBtnText) {
        killBtnText.textContent = currentSession;
      }
      
      // Load session-specific config if it exists
      await loadSessionConfig(currentSession);
      
      // Update loop status for the new session
      updateLoopStatus();
      
      // Don't automatically restart monitor - let user control it
      // Just update the display to reflect the new session
      updateMonitorStatus();
      updateLogs();
      
      // Clear the flag after a delay to allow UI to settle
      setTimeout(() => {
        isSwitchingSessions = false;
      }, 500);
    }
    
    // Update session dropdown to reflect any changes
    updateSessionDropdown = async function() {
      await loadTmuxSessions();
    }
    
    // Update monitor status indicator
    updateMonitorStatus = async function() {
      const statusText = document.getElementById('monitor-status-text');
      
      try {
        if (!currentSession) {
          console.log('No session selected for monitor status');
          statusText.innerHTML = '<span style="color: var(--text-secondary);">No session selected</span>';
          isMonitorRunning = false;
          return;
        }
        const instance = currentSession;
        const response = await fetch('/api/log-monitor/status?instance=' + encodeURIComponent(instance));
        const data = await response.json();
        
        if (data.running) {
          statusText.innerHTML = '<span style="color: var(--success);">✓ Capturing ' + instance + '</span>';
          isMonitorRunning = true;
        } else {
          statusText.innerHTML = '<span style="color: var(--danger);">✗ Not running</span>';
          isMonitorRunning = false;
        }
        
        // Also check message monitor status
        updateMessageMonitorStatus();
      } catch (error) {
        console.error('Failed to check monitor status:', error);
        const statusText = document.getElementById('monitor-status-text');
        statusText.innerHTML = '<span style="color: var(--warning);">? Unknown</span>';
      }
    }
    
    // Track if message monitor is available
    let messageMonitorAvailable = false;
    let messageMonitorCheckCount = 0;
    const MAX_MESSAGE_MONITOR_CHECKS = 3;
    
    // Update message monitor status
    async function updateMessageMonitorStatus() {
      // Skip if we've already determined it's not available
      if (!messageMonitorAvailable && messageMonitorCheckCount >= MAX_MESSAGE_MONITOR_CHECKS) {
        const statusEl = document.getElementById('message-monitor-status');
        if (statusEl) {
          statusEl.innerHTML = '<span style="color: var(--text-secondary);">- Disabled</span>';
        }
        return;
      }
      
      try {
        const response = await fetch('http://localhost:3458/status');
        if (!response.ok) {
          throw new Error('Message monitor not running');
        }
        
        // Mark as available if successful
        messageMonitorAvailable = true;
        messageMonitorCheckCount = 0;
        
        const data = await response.json();
        const statusEl = document.getElementById('message-monitor-status');
        
        if (data.sessions && data.sessions.length > 0) {
          const currentSessionData = data.sessions.find(s => s.session === currentSession);
          if (currentSessionData) {
            if (currentSessionData.isThinking) {
              statusEl.innerHTML = '<span style="color: var(--info);">🤔 Thinking... ' + currentSessionData.thinkingDuration + 's</span>';
            } else {
              statusEl.innerHTML = '<span style="color: var(--success);">✓ Active (' + currentSessionData.context + '% context)</span>';
            }
          } else {
            statusEl.innerHTML = '<span style="color: var(--success);">✓ Running</span>';
          }
        } else {
          statusEl.innerHTML = '<span style="color: var(--warning);">✗ Not running</span>';
        }
      } catch (error) {
        messageMonitorCheckCount++;
        const statusEl = document.getElementById('message-monitor-status');
        if (statusEl) {
          // Don't show error color - message monitor is optional
          statusEl.innerHTML = '<span style="color: var(--text-secondary);">- Not running</span>';
        }
        // Silently ignore - message monitor is optional
      }
    }
    
    function updateLogLines() {
      const select = document.getElementById('log-lines-select');
      currentLogLines = parseInt(select.value);
      updateLogs();
    }
    
    // Conversation Management Functions
    function toggleConversationManager() {
      const manager = document.getElementById('conversation-manager');
      if (manager) {
        manager.style.display = manager.style.display === 'none' ? 'block' : 'none';
        if (manager.style.display === 'block') {
          // Trigger scan when opening conversation manager for the first time
          refreshConversationList(true);
          updateCurrentConversation();
        }
      }
    }
    
    // Scan conversation tree (force rescan)
    window.scanConversationTree = async function scanConversationTree(full = false) {
      try {
        const listContainer = document.getElementById('conversation-list');
        if (listContainer) {
          listContainer.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 10px;">Scanning conversations...</div>';
        }
        
        const response = await fetch('/api/conversation/scan?full=' + full, {
          method: 'POST'
        });
        
        const result = await response.json();
        
        if (result.success) {
          const msg = 'Scan complete: ' + result.updatedCount + ' updated, ' + 
                     result.deletedCount + ' deleted, ' + result.totalCount + ' total';
          
          // Show success message
          const tempMsg = document.createElement('div');
          tempMsg.style.cssText = 'position: fixed; top: 20px; right: 20px; background: var(--success); color: white; padding: 10px 20px; border-radius: 4px; z-index: 1000;';
          tempMsg.textContent = msg;
          document.body.appendChild(tempMsg);
          setTimeout(() => tempMsg.remove(), 3000);
          
          // Refresh the list (already scanned, don't need to scan again)
          await refreshConversationList();
        }
      } catch (error) {
        console.error('Error scanning conversations:', error);
        alert('Failed to scan conversations: ' + error.message);
      }
    }
    
    // Build tree HTML for a conversation and its children
    function buildConversationTreeHTML(conv, allConversations, level = 0, processedIds = new Set()) {
      // Prevent infinite loops
      if (processedIds.has(conv.id)) {
        return '';
      }
      processedIds.add(conv.id);
      
      const indent = level * 20;
      const hasChildren = conv.children && conv.children.length > 0;
      
      // Helper function to format relative time
      function getRelativeTime(date) {
        const now = new Date();
        const then = new Date(date);
        const diffMs = now - then;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);
        
        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return diffMins + ' minute' + (diffMins === 1 ? '' : 's') + ' ago';
        if (diffHours < 24) return diffHours + ' hour' + (diffHours === 1 ? '' : 's') + ' ago';
        if (diffDays < 7) return diffDays + ' day' + (diffDays === 1 ? '' : 's') + ' ago';
        return then.toLocaleDateString();
      }
      
      let html = '<div class="tree-node" style="margin-left: ' + indent + 'px;">';
      html += '<div class="conversation-tree-item" data-conversation-id="' + conv.id + '" ' +
              'style="padding: 8px; margin-bottom: 4px; background: var(--bg-primary); ' +
              'border: 1px solid var(--bg-tertiary); border-radius: 4px; ' +
              'display: flex; align-items: center;">';
      
      // Expand/collapse icon if has children
      if (hasChildren) {
        html += '<span class="tree-expand-icon" onclick="window.toggleTreeNode(this)" ' +
                'style="cursor: pointer; margin-right: 8px; user-select: none;">▼</span>';
      } else {
        html += '<span style="margin-right: 8px; opacity: 0.3;">•</span>';
      }
      
      // Conversation info
      html += '<div style="flex: 1;">';
      html += '<div style="font-size: 12px;">';
      html += '<strong>' + (conv.name || conv.firstUserMessage || conv.id.substring(0, 8)) + '</strong>';
      if (conv.parentId) {
        html += ' <span style="color: var(--text-secondary); font-size: 11px;">↳ resumed</span>';
      }
      html += '</div>';
      html += '<div style="font-size: 11px; color: var(--text-secondary);">';
      html += conv.messageCount + ' messages • ' + getRelativeTime(conv.timestamp);
      html += '</div>';
      html += '</div>';
      
      // Action buttons
      html += '<button class="button button-small" onclick="window.assignConversation(\\\'' + conv.id + '\\\')" ' +
              'style="padding: 3px 8px; font-size: 11px; margin-right: 5px;">Assign</button>';
      html += '<button class="button button-small button-success" onclick="window.assignAndResumeConversation(\\\'' + conv.id + '\\\')" ' +
              'style="padding: 3px 8px; font-size: 11px;">Resume</button>';
      
      html += '</div>';
      
      // Children container
      if (hasChildren) {
        html += '<div class="tree-children">';
        for (const childId of conv.children) {
          const childConv = allConversations[childId];
          if (childConv) {
            html += buildConversationTreeHTML(childConv, allConversations, level + 1, processedIds);
          }
        }
        html += '</div>';
      }
      
      html += '</div>';
      
      return html;
    }
    
    // Track last scan time for staleness check
    let lastTreeScanTime = 0;
    const TREE_STALE_THRESHOLD = 120000; // 2 minutes
    
    // Toggle tree node expansion
    window.toggleTreeNode = async function(icon) {
      const treeNode = icon.closest('.tree-node');
      const children = treeNode.querySelector('.tree-children');
      
      if (children) {
        if (children.style.display === 'none') {
          children.style.display = 'block';
          icon.textContent = '▼';
          
          // Check if data is stale when expanding
          const now = Date.now();
          if (now - lastTreeScanTime > TREE_STALE_THRESHOLD) {
            console.log('Tree data is stale, refreshing...');
            lastTreeScanTime = now;
            // Refresh in background without disrupting UI
            refreshConversationList(true);
          }
        } else {
          children.style.display = 'none';
          icon.textContent = '▶';
        }
      }
    }
    
    // Setup event listeners for conversation buttons
    function setupConversationEventListeners() {
      // These are handled by onclick attributes in the HTML
      // This function is a placeholder for future event delegation if needed
    }
    
    async function updateCurrentConversation() {
      try {
        const response = await fetch('/api/conversation/get?session=' + currentSession);
        const data = await response.json();
        
        const idSpan = document.getElementById('current-conversation-id');
        if (idSpan) {
          if (data && data.conversationId) {
            idSpan.textContent = data.conversationId;
            idSpan.title = 'Tracked at: ' + (data.trackedAt || 'Unknown');
          } else {
            idSpan.textContent = 'None tracked';
          }
        }
      } catch (error) {
        console.error('Error getting current conversation:', error);
      }
    }
    
    window.refreshConversationList = async function refreshConversationList(triggerScan = false) {
      const listContainer = document.getElementById('conversation-list');
      if (!listContainer) return;
      
      listContainer.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 10px;">Loading...</div>';
      
      const groupByProject = document.getElementById('group-by-project').checked;
      const showTreeView = document.getElementById('show-tree-view').checked;
      
      // Update scan time if triggering scan
      if (triggerScan && showTreeView) {
        lastTreeScanTime = Date.now();
      }
      
      // If tree view is enabled, use the tree API
      if (showTreeView) {
        try {
          // Only scan when explicitly triggered
          const treeResponse = await fetch('/api/conversation/tree' + (triggerScan ? '?refresh=true' : ''));
          if (!treeResponse.ok) {
            throw new Error('Failed to fetch conversation tree');
          }
          
          const treeData = await treeResponse.json();
          
          if (treeData.tree.length === 0) {
            listContainer.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 20px;">No conversations found</div>';
            return;
          }
          
          // Get conversation names
          const conversationNamer = window.conversationNamer || { names: {} };
          
          // Build a map of all conversations for easy lookup
          const allConversations = {};
          const buildConvMap = (convs) => {
            for (const conv of convs) {
              // Add custom name if exists
              if (conversationNamer.names && conversationNamer.names[conv.id]) {
                conv.name = conversationNamer.names[conv.id];
              }
              allConversations[conv.id] = conv;
            }
          };
          
          // Tree API already returns all conversations with fresh data
          
          // Reconstruct all conversations from tree structure
          function extractAllConversations(tree) {
            const convs = {};
            function traverse(nodes) {
              for (const node of nodes) {
                convs[node.id] = node;
                if (node.children && node.children.length > 0) {
                  // Children will be added when we traverse them
                }
              }
            }
            traverse(tree);
            return convs;
          }
          
          // Extract conversations and enrich with names
          const extractedConvs = extractAllConversations(treeData.tree);
          for (const id in extractedConvs) {
            if (conversationNamer.names && conversationNamer.names[id]) {
              extractedConvs[id].name = conversationNamer.names[id];
            }
            allConversations[id] = extractedConvs[id];
          }
          
          let html = '<div style="padding: 10px;">';
          html += '<div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 10px;">';
          
          // Simple, subtle update time
          const scanTime = treeData.lastScan ? new Date(treeData.lastScan) : null;
          const ageMinutes = scanTime ? Math.floor((Date.now() - scanTime.getTime()) / 60000) : 0;
          
          html += 'Tree View • ' + treeData.totalCount + ' conversations';
          if (scanTime) {
            html += '<span style="opacity: 0.5; margin-left: 10px; font-size: 11px;">updated ' + ageMinutes + 'm ago</span>';
          }
          html += '</div>';
          
          // Build tree HTML for root conversations
          for (const rootConv of treeData.tree) {
            html += buildConversationTreeHTML(rootConv, allConversations);
          }
          
          html += '</div>';
          
          listContainer.innerHTML = html;
          
          // Add event listeners for buttons
          setupConversationEventListeners();
          
          return;
        } catch (error) {
          console.error('Error loading tree view:', error);
          // Fall back to regular view
        }
      }
      
      // Regular grouped view
      try {
        const response = await fetch('/api/conversation/list?grouped=' + groupByProject);
        if (!response.ok) {
          throw new Error('HTTP error! status: ' + response.status);
        }
        const data = await response.json();
        
        if (data.grouped) {
          // Handle grouped conversations
          const groups = data.conversations;
          if (Object.keys(groups).length === 0) {
            listContainer.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 20px;">No conversations found</div>';
            return;
          }
          
          // Get current working directory
          const workingDirInput = document.getElementById('working-directory');
          const workingDir = (workingDirInput && workingDirInput.value) ? workingDirInput.value : '${HOME_DIR}';
          
          // Get current tracked conversation
          const trackedResponse = await fetch('/api/conversation/get?session=' + currentSession);
          const trackedData = await trackedResponse.json();
          const currentConvId = trackedData && trackedData.conversationId;
          
          let html = '';
          
          // Helper function to format relative time
          function getRelativeTime(date) {
            const now = new Date();
            const then = new Date(date);
            const diffMs = now - then;
            const diffMins = Math.floor(diffMs / 60000);
            const diffHours = Math.floor(diffMs / 3600000);
            const diffDays = Math.floor(diffMs / 86400000);
            
            if (diffMins < 1) return 'Just now';
            if (diffMins < 60) return diffMins + ' minute' + (diffMins === 1 ? '' : 's') + ' ago';
            if (diffHours < 24) return diffHours + ' hour' + (diffHours === 1 ? '' : 's') + ' ago';
            if (diffDays < 7) return diffDays + ' day' + (diffDays === 1 ? '' : 's') + ' ago';
            return then.toLocaleDateString();
          }
          
          // Sort projects to put current working directory first
          const projectDirs = Object.keys(groups).sort((a, b) => {
            if (a === workingDir) return -1;
            if (b === workingDir) return 1;
            return a.localeCompare(b);
          });
          
          // Render each project group
          projectDirs.forEach((projectDir, groupIndex) => {
            const conversations = groups[projectDir];
            const isCurrentProject = projectDir === workingDir;
            const projectName = projectDir.split('/').pop() || 'Root';
            
            html += '<div class="project-group">';
            html += '<div class="project-header' + (isCurrentProject ? ' current-project' : '') + '" ' +
                    'onclick="toggleProjectGroup(this)">';
            html += '<div>';
            html += '<span class="expand-icon" style="margin-right: 10px; display: inline-block; transition: transform 0.2s;">' + (isCurrentProject ? '▼' : '▶') + '</span>';
            html += '<span style="font-weight: bold;">📁 ' + projectName + '</span>';
            html += '<span style="margin-left: 10px; font-size: 11px; opacity: 0.8;">(' + conversations.length + ' conversations)</span>';
            if (isCurrentProject) {
              html += '<span style="margin-left: 10px; font-size: 11px; color: var(--success); font-weight: bold;">CURRENT</span>';
            }
            html += '</div>';
            html += '<div style="font-size: 11px; opacity: 0.8;">' + projectDir + '</div>';
            html += '</div>';
            
            html += '<div class="project-conversations' + (!isCurrentProject ? ' collapsed' : '') + '">';
            
            conversations.forEach((conv, index) => {
              const isActive = currentConvId === conv.id;
              
              html += '<div class="conversation-item' + (isActive ? ' active' : '') + '" ' +
                'data-conversation-id="' + conv.id + '" ' +
                'style="' +
                'padding: 10px;' +
                'margin-bottom: 5px;' +
                'background: ' + (isActive ? 'var(--bg-secondary)' : 'var(--bg-primary)') + ';' +
                'border: 1px solid ' + (isActive ? 'var(--primary)' : 'var(--bg-tertiary)') + ';' +
                'border-radius: 4px;' +
                'cursor: pointer;' +
                'transition: all 0.2s;' +
                '">' +
                  '<div style="display: flex; justify-content: space-between; align-items: start;">' +
                    '<div style="flex: 1;">' +
                      '<div style="font-size: 12px; font-weight: ' + (isActive ? 'bold' : 'normal') + ';">' +
                        (index + 1) + '. ' + 
                        '<span class="conversation-title" data-conversation-id="' + conv.id + '">' + 
                        (conv.title || 'Conversation ' + conv.fileSizeStr) + 
                        '</span>' +
                        (isActive ? '<span style="color: var(--primary); margin-left: 5px;">✓ Active</span>' : '') +
                        '<button class="rename-btn" data-conversation-id="' + conv.id + '" style="margin-left: 5px; font-size: 10px; padding: 2px 6px; background: transparent; border: 1px solid var(--bg-tertiary); border-radius: 3px; cursor: pointer;" title="Rename conversation">✏️</button>' +
                        '<button class="delete-btn" data-conversation-id="' + conv.id + '" data-project-path="' + encodeURIComponent(projectDir) + '" style="margin-left: 5px; font-size: 10px; padding: 2px 6px; background: transparent; border: 1px solid var(--error); border-radius: 3px; cursor: pointer; color: var(--error);" title="Delete conversation">🗑️</button>' +
                      '</div>' +
                      '<div style="font-size: 11px; color: var(--text-secondary); margin-top: 4px;">' +
                        conv.fileSizeStr + ' • ' + getRelativeTime(conv.lastModified) +
                      '</div>' +
                    '</div>' +
                    '<button class="button button-small button-primary assign-conversation-btn" ' +
                            'data-conversation-id="' + conv.id + '" ' +
                            'style="padding: 4px 8px; font-size: 11px; margin-right: 5px;">' +
                      (isActive ? 'Active' : 'Assign') +
                    '</button>' +
                    (!isActive ? '<button class="button button-small button-success assign-resume-btn" ' +
                            'data-conversation-id="' + conv.id + '" ' +
                            'style="padding: 4px 8px; font-size: 11px;" title="Assign conversation and start Claude with it">' +
                      '▶️ Resume' +
                    '</button>' : '') +
                  '</div>' +
                '</div>';
            });
            
            html += '</div>'; // project-conversations
            html += '</div>'; // project-group
          });
          
          listContainer.innerHTML = html;
          
        } else {
          // Handle flat list (existing code)
          if (!data.conversations || data.conversations.length === 0) {
            listContainer.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 20px;">No conversations found</div>';
            return;
          }
          
          // Get current tracked conversation
          const trackedResponse = await fetch('/api/conversation/get?session=' + currentSession);
          const trackedData = await trackedResponse.json();
          const currentConvId = trackedData && trackedData.conversationId;
          
          let html = '';
          data.conversations.forEach((conv, index) => {
            const isActive = currentConvId === conv.id;
          
          html += '<div class="conversation-item' + (isActive ? ' active' : '') + '" ' +
            'data-conversation-id="' + conv.id + '" ' +
            'style="' +
            'padding: 10px;' +
            'margin-bottom: 5px;' +
            'background: ' + (isActive ? 'var(--bg-secondary)' : 'var(--bg-primary)') + ';' +
            'border: 1px solid ' + (isActive ? 'var(--primary)' : 'var(--bg-tertiary)') + ';' +
            'border-radius: 4px;' +
            'cursor: pointer;' +
            'transition: all 0.2s;' +
            '">' +
              '<div style="display: flex; justify-content: space-between; align-items: start;">' +
                '<div style="flex: 1;">' +
                  '<div style="font-size: 12px; font-weight: ' + (isActive ? 'bold' : 'normal') + ';">' +
                    (index + 1) + '. ' + conv.title +
                    (isActive ? '<span style="color: var(--primary); margin-left: 5px;">✓ Active</span>' : '') +
                  '</div>' +
                  '<div style="font-size: 11px; color: var(--text-secondary); margin-top: 4px;">' +
                    conv.messageCount + ' messages • Modified ' + new Date(conv.lastModified).toLocaleString() +
                  '</div>' +
                  '<div style="font-size: 10px; color: var(--text-secondary); margin-top: 2px; font-family: monospace;">' +
                    conv.id +
                  '</div>' +
                '</div>' +
                '<button class="button button-small button-primary assign-conversation-btn" ' +
                        'data-conversation-id="' + conv.id + '" ' +
                        'style="padding: 4px 8px; font-size: 11px;">' +
                  (isActive ? 'Active' : 'Assign') +
                '</button>' +
              '</div>' +
            '</div>';
        });
        
        listContainer.innerHTML = html;
        }
        
        // Add single click handler for all conversation actions using event delegation
        listContainer.addEventListener('click', async function(e) {
          e.stopPropagation();
          
          // Handle delete buttons
          if (e.target.classList.contains('delete-btn')) {
            const convId = e.target.getAttribute('data-conversation-id');
            const projectPath = decodeURIComponent(e.target.getAttribute('data-project-path'));
            if (convId && projectPath) {
              await deleteConversation(convId, projectPath);
            }
            return;
          }
          
          // Handle rename buttons
          if (e.target.classList.contains('rename-btn')) {
            const convId = e.target.getAttribute('data-conversation-id');
            if (convId) {
              await renameConversation(convId);
            }
            return;
          }
          
          // Handle assign & resume buttons
          if (e.target.classList.contains('assign-resume-btn')) {
            const convId = e.target.getAttribute('data-conversation-id');
            if (convId) {
              await assignAndResumeConversation(convId);
            }
            return;
          }
          
          // Handle assign buttons
          const assignButton = e.target.closest('.assign-conversation-btn');
          if (assignButton) {
            const convId = assignButton.getAttribute('data-conversation-id');
            if (convId) {
              assignConversation(convId);
            }
            return;
          }
          
          // Handle conversation item clicks
          const item = e.target.closest('.conversation-item');
          if (item && !e.target.closest('button')) {
            const convId = item.getAttribute('data-conversation-id');
            if (convId) {
              assignConversation(convId);
            }
          }
        }, { once: true }); // Remove listener before next refresh
      } catch (error) {
        console.error('Error loading conversations:', error);
        listContainer.innerHTML = '<div style="text-align: center; color: var(--error); padding: 20px;">Error loading conversations</div>';
      }
    }
    
    window.assignConversation = async function assignConversation(conversationId) {
      try {
        const workingDirInput = document.getElementById('working-directory');
        const workingDir = (workingDirInput && workingDirInput.value) ? workingDirInput.value : '${HOME_DIR}';
        
        const response = await fetch('/api/conversation/assign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session: currentSession,
            conversationId: conversationId,
            workingDirectory: workingDir
          })
        });
        
        const result = await response.json();
        if (result.success) {
          // Update the active conversation dropdown to show this conversation as selected
          const activeDropdown = document.getElementById('active-conversation');
          if (activeDropdown) {
            activeDropdown.value = conversationId;
            // Store in localStorage for persistence
            localStorage.setItem('claudeLoop_activeConversation_' + currentSession, conversationId);
          }
          
          updateCurrentConversation();
          refreshConversationList();
          
          // Show success message
          const listContainer = document.getElementById('conversation-list');
          const tempMsg = document.createElement('div');
          tempMsg.style.cssText = 'position: fixed; top: 20px; right: 20px; background: var(--success); color: white; padding: 10px 20px; border-radius: 4px; z-index: 1000;';
          tempMsg.textContent = 'Conversation assigned successfully!';
          document.body.appendChild(tempMsg);
          setTimeout(() => tempMsg.remove(), 3000);
        }
      } catch (error) {
        console.error('Error assigning conversation:', error);
        alert('Failed to assign conversation: ' + error.message);
      }
    }
    
    window.assignAndResumeConversation = async function assignAndResumeConversation(conversationId) {
      try {
        // First, assign the conversation
        const workingDirInput = document.getElementById('working-directory');
        const workingDir = (workingDirInput && workingDirInput.value) ? workingDirInput.value : HOME_DIR;
        
        // Show info message
        const infoMsg = document.createElement('div');
        infoMsg.style.cssText = 'position: fixed; top: 20px; right: 20px; background: var(--primary); color: white; padding: 10px 20px; border-radius: 4px; z-index: 1000;';
        infoMsg.textContent = 'Assigning conversation and starting Claude...';
        document.body.appendChild(infoMsg);
        setTimeout(() => infoMsg.remove(), 2000);
        
        // Assign the conversation
        const assignResponse = await fetch('/api/conversation/assign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session: currentSession,
            conversationId: conversationId,
            workingDirectory: workingDir
          })
        });
        
        if (!assignResponse.ok) {
          throw new Error('Failed to assign conversation');
        }
        
        // Wait a moment for assignment to complete
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Start logging if not already running
        const logStatus = document.getElementById('monitor-status-text');
        if (logStatus && logStatus.textContent !== 'Running') {
          await controlLogMonitor('start');
        }
        
        // Get the conversation details to check its working directory
        const convListResponse = await fetch('/api/conversation/list?grouped=true');
        const convListData = await convListResponse.json();
        let convWorkingDir = null;
        
        if (convListData.conversations) {
          for (const dir in convListData.conversations) {
            const conv = convListData.conversations[dir].find(c => c.id === conversationId);
            if (conv) {
              convWorkingDir = conv.projectPath;
              break;
            }
          }
        }
        
        // Update working directory if conversation is from a different directory
        if (convWorkingDir && convWorkingDir !== workingDir) {
          document.getElementById('working-directory').value = convWorkingDir;
          // Trigger change event for auto-save
          document.getElementById('working-directory').dispatchEvent(new Event('input'));
          
          // Show notification about directory change
          const dirMsg = document.createElement('div');
          dirMsg.style.cssText = 'position: fixed; top: 20px; right: 20px; background: var(--warning); color: white; padding: 10px 20px; border-radius: 4px; z-index: 1000;';
          dirMsg.textContent = 'Working directory changed to: ' + convWorkingDir;
          document.body.appendChild(dirMsg);
          setTimeout(() => dirMsg.remove(), 3000);
        }
        
        // Now restart and resume Claude with the assigned conversation
        await restartAndResumeSession();
        
        // Wait a moment for the session to be tracked, then refresh the list and update active
        setTimeout(async () => {
          // Update the active conversation dropdown to show this conversation as selected
          const activeDropdown = document.getElementById('active-conversation');
          if (activeDropdown) {
            activeDropdown.value = conversationId;
            // Store in localStorage for persistence
            localStorage.setItem('claudeLoop_activeConversation_' + currentSession, conversationId);
          }
          
          // Trigger scan since a new conversation was likely created
          await refreshConversationList(true);
          await updateCurrentConversation();
        }, 2000);
        
      } catch (error) {
        console.error('Error in assign and resume:', error);
        alert('Failed to assign and resume: ' + error.message);
      }
    }
    
    async function deleteConversation(conversationId, projectPath) {
      try {
        // Get conversation name for better confirmation message
        const nameResponse = await fetch('/api/conversation/name?conversationId=' + conversationId);
        const nameData = await nameResponse.json();
        const convName = nameData.name || conversationId;
        
        // Confirm deletion
        if (!confirm('Are you sure you want to delete this conversation?\\n\\n"' + convName + '"\\n\\nThe conversation will be moved to trash and can be recovered if needed.')) {
          return;
        }
        
        // Delete the conversation (move to trash)
        const response = await fetch('/api/conversation/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversationId: conversationId,
            projectPath: projectPath
          })
        });
        
        if (!response.ok) {
          throw new Error('Failed to delete conversation');
        }
        
        // Remove the custom name if it exists
        await fetch('/api/conversation/name?conversationId=' + conversationId, {
          method: 'DELETE'
        });
        
        // Refresh the conversation list
        await refreshConversationList();
        
        // Show success message
        const tempMsg = document.createElement('div');
        tempMsg.style.cssText = 'position: fixed; top: 20px; right: 20px; background: var(--success); color: white; padding: 10px 20px; border-radius: 4px; z-index: 1000;';
        tempMsg.textContent = 'Conversation moved to trash';
        document.body.appendChild(tempMsg);
        setTimeout(() => tempMsg.remove(), 3000);
        
      } catch (error) {
        console.error('Error deleting conversation:', error);
        alert('Failed to delete conversation: ' + error.message);
      }
    }
    
    async function browseDirectory() {
      try {
        const currentDir = document.getElementById('working-directory').value || HOME_DIR;
        
        // Create modal for directory browser
        const modal = document.createElement('div');
        modal.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 9999; display: flex; justify-content: center; align-items: center;';
        
        const dialog = document.createElement('div');
        dialog.style.cssText = 'background: var(--bg-primary); border: 1px solid var(--bg-tertiary); border-radius: 8px; padding: 20px; width: 500px; max-height: 600px; overflow: hidden; display: flex; flex-direction: column;';
        
        dialog.innerHTML = '<h3 style="margin: 0 0 15px 0;">Select Directory</h3>' +
          '<div id="current-path" style="padding: 10px; background: var(--bg-secondary); border-radius: 4px; margin-bottom: 10px; font-family: monospace; font-size: 12px;"></div>' +
          '<div id="directory-list" style="flex: 1; overflow-y: auto; border: 1px solid var(--bg-tertiary); border-radius: 4px; padding: 10px; background: var(--bg-secondary);"></div>' +
          '<div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 15px;">' +
            '<button onclick="this.closest(\\'.modal\\').remove()" style="padding: 8px 16px; background: var(--bg-tertiary); color: var(--text-primary); border: none; border-radius: 4px; cursor: pointer;">Cancel</button>' +
            '<button id="select-dir-btn" style="padding: 8px 16px; background: var(--primary); color: white; border: none; border-radius: 4px; cursor: pointer;">Select</button>' +
          '</div>';
        
        modal.appendChild(dialog);
        modal.classList.add('modal');
        document.body.appendChild(modal);
        
        let selectedPath = currentDir;
        
        async function loadDirectory(dir) {
          try {
            const response = await fetch('/api/browse-directory', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ directory: dir })
            });
            
            const data = await response.json();
            selectedPath = data.currentPath;
            
            document.getElementById('current-path').textContent = data.currentPath;
            
            const listEl = document.getElementById('directory-list');
            listEl.innerHTML = '';
            
            data.directories.forEach(dir => {
              const item = document.createElement('div');
              item.style.cssText = 'padding: 8px; margin: 2px 0; cursor: pointer; border-radius: 4px; transition: background 0.2s;';
              item.innerHTML = '📁 ' + dir.name;
              item.onmouseover = () => item.style.background = 'var(--bg-tertiary)';
              item.onmouseout = () => item.style.background = 'transparent';
              item.onclick = () => loadDirectory(dir.path);
              listEl.appendChild(item);
            });
          } catch (error) {
            alert('Error loading directory: ' + error.message);
          }
        }
        
        // Load initial directory
        await loadDirectory(currentDir);
        
        // Handle select button
        document.getElementById('select-dir-btn').onclick = () => {
          document.getElementById('working-directory').value = selectedPath;
          // Trigger change event for auto-save
          document.getElementById('working-directory').dispatchEvent(new Event('input'));
          modal.remove();
        };
        
      } catch (error) {
        console.error('Error in directory browser:', error);
        alert('Failed to open directory browser: ' + error.message);
      }
    }
    
    async function renameConversation(conversationId) {
      try {
        // Get current name if exists
        const nameResponse = await fetch('/api/conversation/name?conversationId=' + conversationId);
        const nameData = await nameResponse.json();
        const currentName = nameData.name || '';
        
        // Prompt for new name
        const newName = prompt('Enter a custom name for this conversation:', currentName);
        if (newName === null) return; // User cancelled
        
        if (newName.trim() === '') {
          // Delete the custom name
          await fetch('/api/conversation/name?conversationId=' + conversationId, {
            method: 'DELETE'
          });
        } else {
          // Set new name
          await fetch('/api/conversation/name', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              conversationId: conversationId,
              name: newName.trim()
            })
          });
        }
        
        // Refresh the conversation list to show the new name
        await refreshConversationList();
        
        // Show success message
        const tempMsg = document.createElement('div');
        tempMsg.style.cssText = 'position: fixed; top: 20px; right: 20px; background: var(--success); color: white; padding: 10px 20px; border-radius: 4px; z-index: 1000;';
        tempMsg.textContent = newName.trim() ? 'Conversation renamed successfully!' : 'Custom name removed';
        document.body.appendChild(tempMsg);
        setTimeout(() => tempMsg.remove(), 2000);
        
      } catch (error) {
        console.error('Error renaming conversation:', error);
        alert('Failed to rename conversation: ' + error.message);
      }
    }
    
    function toggleProjectGroup(header) {
      const conversations = header.nextElementSibling;
      const arrow = header.querySelector('.expand-icon');
      
      if (conversations.classList.contains('collapsed')) {
        conversations.classList.remove('collapsed');
        if (arrow) arrow.textContent = '▼';
      } else {
        conversations.classList.add('collapsed');
        if (arrow) arrow.textContent = '▶';
      }
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
    
    // Pause-on-interaction variables
    let isUserInteracting = false;
    let isMouseDown = false;
    let interactionTimeout = null;
    const INTERACTION_RESUME_DELAY = 3000; // Resume 3 seconds after interaction stops
    
    // Check if user has text selected
    function hasTextSelected() {
      const selection = window.getSelection();
      return selection && selection.toString().length > 0;
    }
    
    // Pause log updates during user interaction
    function pauseLogUpdates(reason = 'selecting text') {
      isUserInteracting = true;
      
      // Clear any existing resume timeout
      if (interactionTimeout) {
        clearTimeout(interactionTimeout);
        interactionTimeout = null;
      }
      
      // Show pause indicator
      const statusEl = document.getElementById('status-text');
      if (statusEl && !statusEl.textContent.includes('Paused')) {
        const originalText = statusEl.textContent;
        statusEl.setAttribute('data-original-text', originalText);
        statusEl.textContent = '⏸️ Updates paused (' + reason + ')';
      }
    }
    
    // Resume log updates after delay
    function resumeLogUpdates() {
      // Don't resume if mouse is still down or text is selected
      if (isMouseDown || hasTextSelected()) {
        return;
      }
      
      // Clear any existing timeout
      if (interactionTimeout) {
        clearTimeout(interactionTimeout);
      }
      
      interactionTimeout = setTimeout(() => {
        isUserInteracting = false;
        
        // Restore original status text
        const statusEl = document.getElementById('status-text');
        if (statusEl) {
          const originalText = statusEl.getAttribute('data-original-text');
          if (originalText) {
            statusEl.textContent = originalText;
            statusEl.removeAttribute('data-original-text');
          }
        }
        
        // Force an update
        updateLogs();
      }, INTERACTION_RESUME_DELAY);
    }
    
    updateLogs = async function(isScrollUpdate = false) {
      // Skip updates if user is interacting
      if (isUserInteracting) {
        return;
      }
      
      // Skip scroll updates if lazy loading is disabled
      if (isScrollUpdate && !lazyLoadingEnabled) {
        return;
      }
      
      // Check if we should skip the update
      if (!isMonitorRunning && !isScrollUpdate) {
        // During transition, still try to fetch logs
        if (isMonitorTransitioning) {
          console.log('[Log Update] Monitor is transitioning, attempting update...');
        } else {
          const logsEl = document.getElementById('logs');
          logsEl.innerHTML = '<span style="color: var(--text-secondary);">No active monitor - Click "Start Console Logging" to begin</span>';
          return;
        }
      }
      
      // Only log non-scroll updates to reduce console noise
      if (!isScrollUpdate) {
        console.log('[Log Update] Auto-refresh at', new Date().toLocaleTimeString());
      }
      try {
        const response = await fetch('/api/logs?maxLines=' + currentLogLines + '&session=' + currentSession);
        const data = await response.json();
        
        
        const logsEl = document.getElementById('logs');
        
        if (!data.logs || data.logs.trim() === '') {
          logsEl.innerHTML = '<span style="color: var(--text-secondary);">No logs available</span>';
          return;
        }
        
        // Just update the logs - no need for hashing
        
        // Check if user is at the bottom before updating
        const wasAtBottom = (logsEl.scrollTop + logsEl.clientHeight) >= (logsEl.scrollHeight - 10);
        
        // Format logs with proper line breaks and styling
        let lines = data.logs.split('\\n');
        
        // Trim trailing empty lines
        while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
          lines.pop();
        }
        
        allLogLines = lines; // Store for virtual scrolling
        
        // Debug: check if we have content
        if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
          console.log('[Log Update] Warning: No log content received');
          logsEl.innerHTML = '<span style="color: var(--text-secondary);">Waiting for logs...</span>';
          return;
        }
        
        // Check for auto-compact trigger phrase - moved here to run regardless of lazy loading
        try {
          // Only log config check if loop is running (reduce noise)
          if (isLoopRunningAndNotPaused) {
            console.log('[Auto-Compact] Config check:', {
              hasCurrentConfig: !!currentConfig,
              currentConfigKeys: currentConfig ? Object.keys(currentConfig) : [],
              session: currentSession
            });
          }
          
          // Get recent lines for checking (used by both auto-compact and auto-pause)
          const recentLines = lines.length > 0 ? lines.slice(-20) : [];
          
          if (currentConfig && currentConfig.conditionalMessages && 
              currentConfig.conditionalMessages.lowContextMessage && 
              currentConfig.conditionalMessages.lowContextMessage.autoCompact && 
              lines.length > 0) {
            // Only proceed if loop is running and not paused
            if (isLoopRunningAndNotPaused) {
            
            // Remove verbose debug logging - we only care about "let's compact!"
            
            // Simple check: if we see "let's compact!" anywhere in recent lines
            const foundLetsCompact = recentLines.some(line => 
              line.toLowerCase().includes("let's compact!")
            );
            if (foundLetsCompact) {
              console.log("[Auto-Compact] Detected 'Let's compact!' phrase!");
              const now = Date.now();
              const fiveMinutes = 5 * 60 * 1000;
              
              // Only trigger if we haven't compacted in the last 5 minutes
              if (now - lastCompactTime >= fiveMinutes) {
                console.log('[Auto-Compact] Sending compact command...');
                await sendCompactCommand();
              } else {
                const timeLeft = Math.ceil((fiveMinutes - (now - lastCompactTime)) / 1000);
                console.log('[Auto-Compact] Cooldown active. Wait ' + timeLeft + ' more seconds');
              }
            }
            } // End of isLoopRunningAndNotPaused check
            
            // Check for "Finished everything for now!" to auto-pause
            const autoFinishEnabled = document.getElementById('auto-finish-enabled')?.checked;
            if (autoFinishEnabled && isMonitorRunning && isLoopRunningAndNotPaused) { // Only check if monitor AND loop are running
              // Find the index of "Finished everything for now!" in recent lines
              let finishedIndex = -1;
              for (let i = recentLines.length - 1; i >= 0; i--) {
                if (recentLines[i].toLowerCase().includes("finished everything for now!")) {
                  finishedIndex = i;
                  break;
                }
              }
              
              if (finishedIndex >= 0) {
                // First check timestamps - only proceed if we haven't already paused since last message
                if (lastMessageSentTime > lastAutoPauseTime) {
                  // Check if there's any meaningful text after "Finished everything for now!"
                  let hasTextAfter = false;
                  for (let i = finishedIndex + 1; i < recentLines.length; i++) {
                    const line = recentLines[i];
                    
                    // Stop checking if we hit the input prompt border
                    if (line.includes('╭───') || line.includes('╭─')) {
                      console.log('[Auto-Pause] Hit input prompt border, stopping check');
                      break;
                    }
                    
                    // Clean the line of ANSI codes and trim
                    const cleanLine = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
                    
                    // Check if this is meaningful text (not empty, not just whitespace)
                    if (cleanLine && cleanLine.length > 0) {
                      hasTextAfter = true;
                      console.log('[Auto-Pause] Found text after finish message:', cleanLine);
                      break;
                    }
                  }
                  
                  // Only proceed if "Finished everything for now!" is the last meaningful text
                  if (!hasTextAfter) {
                    console.log("[Auto-Pause] Detected 'Finished everything for now!' phrase!");
                    console.log("[Auto-Pause] Last message sent:", new Date(lastMessageSentTime).toLocaleTimeString());
                    console.log("[Auto-Pause] Last auto-pause:", lastAutoPauseTime ? new Date(lastAutoPauseTime).toLocaleTimeString() : 'Never');
                    
                    // Update last pause time immediately to prevent multiple triggers
                    lastAutoPauseTime = Date.now();
                    
                    // First send /compact command to Claude
                    console.log("[Auto-Pause] Sending /compact command to Claude");
                    await window.sendMessage('/compact', currentSession);
                    
                    // Wait a moment for compact to process
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    
                    // Then pause the loop
                    await controlLoop('pause');
                    
                    // Show notification
                    const statusText = document.getElementById('status-text');
                    statusText.textContent = '⏸️ Loop auto-paused: Claude finished all todos (compacted first)';
                  } else {
                    console.log('[Auto-Pause] Skipping - found text after finish message');
                  }
                } else {
                  // We've already paused since the last message, don't spam
                  console.log('[Auto-Pause] Already paused since last message sent, skipping');
                }
              }
            }
          }
        } catch (e) {
          console.error('[Auto-Compact] Error in detection:', e);
        }
        
        // If lazy loading is disabled, always render all lines
        if (!lazyLoadingEnabled) {
          const formattedLines = lines.map(line => {
            let escaped = convertAnsiToHtml(line);
            return escaped;
          });
          
          // Wrap content to prevent over-scrolling
          logsEl.innerHTML = '<div style="padding-bottom: 20px;">' + formattedLines.join('<br>') + '</div>';
          
          // Only auto-scroll if user was already at the bottom
          if (wasAtBottom) {
            logsEl.scrollTop = logsEl.scrollHeight;
          }
          
          // Update log info
          const logInfo = document.getElementById('log-info');
          if (logInfo) {
            const lineCount = lines.length;
            const sizeKB = (data.logs.length / 1024).toFixed(1);
            logInfo.textContent = lineCount + ' lines, ' + sizeKB + ' KB';
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
          
          // Wrap content to prevent over-scrolling
          logsEl.innerHTML = '<div style="padding-bottom: 20px;">' + formattedLines.join('<br>') + '</div>';
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
            return '<span style="color: var(--danger);">' + escaped + '</span>';
          } else if (line.includes('[WARNING]') || line.includes('⚠️')) {
            return '<span style="color: var(--warning);">' + escaped + '</span>';
          } else if (line.includes('[SUCCESS]') || line.includes('✅')) {
            return '<span style="color: var(--success);">' + escaped + '</span>';
          } else if (line.includes('[INFO]') || line.includes('ℹ️')) {
            return '<span style="color: var(--accent);">' + escaped + '</span>';
          } else if (line.startsWith('Human:') || line.startsWith('Assistant:')) {
            return '<span style="color: var(--accent); font-weight: bold;">' + escaped + '</span>';
          } else if (line.includes('\`\`\`')) {
            return '<span style="color: var(--text-secondary); font-family: monospace;">' + escaped + '</span>';
          }
          
          return escaped;
        });
        
        // Create virtual scrolling container with minimal bottom spacer
        const bottomSpacerHeight = Math.min(50, (lines.length - visibleEnd) * lineHeight); // Max 50px bottom margin
        const html = 
          '<div style="height: ' + (visibleStart * lineHeight) + 'px;"></div>' +
          formattedLines.join('<br>') +
          '<div style="height: ' + bottomSpacerHeight + 'px;"></div>';
        
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
          logInfo.textContent = lineCount + ' lines, ' + sizeKB + ' KB';
        }
      } catch (error) {
        console.error('Failed to update logs:', error);
      }
    }
    
    async function sendCompactCommand() {
      // Prevent sending multiple compact commands too quickly
      const now = Date.now();
      const fiveMinutes = 5 * 60 * 1000; // 5 minutes in milliseconds
      if (now - lastCompactTime < fiveMinutes) {
        const timeRemaining = Math.ceil((fiveMinutes - (now - lastCompactTime)) / 1000);
        console.log('Skipping compact - too soon since last compact. Wait ' + timeRemaining + ' more seconds');
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
    
    // Message history management
    const messageHistory = [];
    let historyIndex = -1;
    let tempCurrentMessage = ''; // Store the current message when navigating history
    
    function handleMessageKeyDown(event) {
      const messageInput = event.target;
      
      // Enter to send message (both regular Enter and Shift+Enter)
      if (event.key === 'Enter' && !event.ctrlKey) {
        // If not holding Shift, prevent default to avoid newline
        if (!event.shiftKey) {
          event.preventDefault();
        }
        event.stopPropagation();
        sendMessage();
        return false;
      }
      
      // Up arrow for history (only when cursor is at start)
      if (event.key === 'ArrowUp' && messageInput.selectionStart === 0) {
        event.preventDefault();
        
        // Save current message if we're just starting to navigate history
        if (historyIndex === -1 && messageInput.value.trim()) {
          tempCurrentMessage = messageInput.value;
        }
        
        if (historyIndex < messageHistory.length - 1) {
          historyIndex++;
          messageInput.value = messageHistory[messageHistory.length - 1 - historyIndex];
        }
        return false;
      }
      
      // Down arrow for history
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        
        if (historyIndex > 0) {
          historyIndex--;
          messageInput.value = messageHistory[messageHistory.length - 1 - historyIndex];
        } else if (historyIndex === 0) {
          // Returning to current message
          historyIndex = -1;
          messageInput.value = tempCurrentMessage;
          tempCurrentMessage = ''; // Clear temp storage
        }
        return false;
      }
      
      // Reset history index when typing (but preserve tempCurrentMessage)
      if (event.key.length === 1 || event.key === 'Backspace' || event.key === 'Delete') {
        if (historyIndex !== -1) {
          historyIndex = -1;
          tempCurrentMessage = ''; // Clear temp storage when user starts typing
        }
      }
    }
    
    async function sendMessage() {
      const messageInput = document.getElementById('custom-message');
      const message = messageInput.value.trim();
      if (!message) return;
      
      // Track when we send a message
      lastMessageSentTime = Date.now();
      console.log('[Message Sent] at:', new Date(lastMessageSentTime).toLocaleTimeString());
      
      // Skip control character validation as it causes issues with HTML encoding
      // Messages are sanitized server-side before being sent to tmux
      
      // Temporarily disable the input to prevent duplicate sends
      messageInput.disabled = true;
      
      try {
        const response = await fetch('/api/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'send-message', message, session: currentSession })
        });
        
        if (response.ok) {
          // Add to history
          messageHistory.push(message);
          historyIndex = -1;
          tempCurrentMessage = ''; // Clear temp storage
          
          // Clear the input field
          messageInput.value = '';
          
          // Show feedback in status text temporarily
          const statusText = document.getElementById('status-text');
          const originalText = statusText.textContent;
          statusText.textContent = '✅ Message sent!';
          setTimeout(() => {
            statusText.textContent = originalText;
          }, 2000);
          
          // Small delay before re-enabling to ensure tmux processes the message
          setTimeout(() => {
            messageInput.disabled = false;
            messageInput.focus();
          }, 100);
        } else {
          throw new Error('Failed to send message');
        }
      } catch (error) {
        console.error('Send message error:', error);
        alert('Failed to send message: ' + error.message);
        messageInput.disabled = false;
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
      // Helper function to update section and arrow
      function updateSection(name) {
        const enabled = document.getElementById(name + '-enabled').checked;
        document.getElementById(name + '-settings').style.display = enabled ? 'block' : 'none';
        const arrow = document.getElementById(name + '-arrow');
        if (arrow) {
          arrow.textContent = enabled ? '▼' : '▶';
        }
      }
      
      // Update all sections
      updateSection('morning');
      updateSection('afternoon');
      updateSection('evening');
      updateSection('standard');
      
      // Show/hide context-based settings
      document.getElementById('low-context-settings').style.display = 
        document.getElementById('low-context-enabled').checked ? 'block' : 'none';
      document.getElementById('after-compact-settings').style.display = 
        document.getElementById('after-compact-enabled').checked ? 'block' : 'none';
      
      // Auto-save
      autoSave();
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
        console.log('Block: ' + startTime + 'h - ' + endTime + 'h, Active: ' + block.isActive + ', Left: ' + leftPercent.toFixed(2) + '%, Width: ' + widthPercent.toFixed(2) + '%');
        
        segment.style.cssText = 
          'position: absolute;' +
          'left: ' + leftPercent + '%;' +
          'width: ' + widthPercent + '%;' +
          'height: 100%;' +
          'background: ' + (block.isActive ? 'var(--success)' : 'var(--danger)') + ';' +
          'opacity: 0.8;';
        
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
        return displayHour + ':' + minutes.toString().padStart(2, '0') + ' ' + period;
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
        tooltip.style.left = (e.clientX - parentRect.left - 25) + 'px';
        tooltip.style.top = (rect.top - parentRect.top - 25) + 'px';
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
        
        dragPreview.style.cssText = 
          'position: absolute;' +
          'left: ' + leftPercent + '%;' +
          'width: ' + widthPercent + '%;' +
          'height: 100%;' +
          'background: ' + (isActive ? 'var(--success)' : 'var(--danger)') + ';' +
          'opacity: 0.5;' +
          'pointer-events: none;' +
          'z-index: 1000;';
        
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
            autoSave(true); // Auto-save immediately after schedule change
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
          autoSave(true);
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
      autoSave(true);
    }
    
    function setWorkHours() {
      scheduleMinutes = new Array(1440).fill(false);
      // Active 9 AM to 5 PM (9*60 to 17*60)
      for (let minute = 540; minute < 1020; minute++) {
        scheduleMinutes[minute] = true;
      }
      updateTimeline();
      autoSave(true);
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
      autoSave(true);
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
          tzDisplay.textContent = 'Timezone: ' + tz + ' (all times shown in local time)';
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
    
    // Auto-save functionality with intelligent debouncing
    // saveTimeout already declared globally at line 2146
    let lastSaveTime = 0;
    const MIN_SAVE_INTERVAL = 5000; // Minimum 5 seconds between saves
    
    // Update save status indicator
    function updateSaveStatus(status) {
      const statusIndicator = document.getElementById('save-status');
      if (!statusIndicator) {
        // Create status indicator if it doesn't exist
        const indicator = document.createElement('div');
        indicator.id = 'save-status';
        indicator.style.cssText = 'position: fixed; top: 10px; right: 10px; padding: 5px 10px; border-radius: 4px; font-size: 12px; z-index: 1000;';
        document.body.appendChild(indicator);
      }
      
      const indicator = document.getElementById('save-status');
      switch (status) {
        case 'pending':
          indicator.textContent = 'Changes pending...';
          indicator.style.backgroundColor = '#ff9800';
          indicator.style.color = 'white';
          break;
        case 'saving':
          indicator.textContent = 'Saving...';
          indicator.style.backgroundColor = '#2196F3';
          indicator.style.color = 'white';
          break;
        case 'saved':
          indicator.textContent = 'Saved';
          indicator.style.backgroundColor = '#4CAF50';
          indicator.style.color = 'white';
          setTimeout(() => {
            indicator.style.display = 'none';
          }, 2000);
          break;
        case 'error':
          indicator.textContent = 'Save failed';
          indicator.style.backgroundColor = '#f44336';
          indicator.style.color = 'white';
          break;
      }
      indicator.style.display = 'block';
    }
    
    function autoSave(isImmediate = false) {
      // Don't auto-save if switching sessions
      if (isSwitchingSessions) {
        console.log('Skipping auto-save - switching sessions');
        return;
      }
      
      console.log('Auto-save triggered', isImmediate ? '(immediate)' : '(debounced)');
      clearTimeout(saveTimeout);
      window.saveTimeout = null;
      
      // Show pending indicator
      updateSaveStatus('pending');
      
      // For immediate saves (checkboxes, schedule changes)
      if (isImmediate) {
        const now = Date.now();
        if (now - lastSaveTime >= MIN_SAVE_INTERVAL) {
          console.log('Calling saveConfig immediately...');
          saveConfig();
          lastSaveTime = now;
        } else {
          // Still debounce if saving too frequently
          const delay = MIN_SAVE_INTERVAL - (now - lastSaveTime);
          saveTimeout = setTimeout(() => {
            if (!isSwitchingSessions) {
              console.log('Calling saveConfig after minimum interval...');
              saveConfig();
              lastSaveTime = Date.now();
            }
          }, delay);
          window.saveTimeout = saveTimeout;
        }
      } else {
        // For text inputs, use longer debounce
        saveTimeout = setTimeout(() => {
          if (!isSwitchingSessions) {
            console.log('Calling saveConfig after text input debounce...');
            saveConfig();
            lastSaveTime = Date.now();
          }
        }, 3000); // Save 3 seconds after last text change
        window.saveTimeout = saveTimeout;
      }
    }
    
    // Load initial config for all sessions
    async function loadInitialConfig() {
      try {
        // Load session-specific config
        await loadSessionConfig(currentSession);
        console.log('Initial config loaded successfully');
      } catch (error) {
        console.error('Failed to load initial config:', error);
        // Use default values from the form
        saveConfig();
      }
    }
    
    // Load config for a specific session
    async function loadSessionConfig(session) {
      try {
        // Try to load session-specific config
        const response = await fetch('/api/config?session=' + encodeURIComponent(session));
        if (response.ok) {
          const config = await response.json();
          sessionConfigs[session] = config;
          
          // Update currentConfig for auto-compact checking
          currentConfig = config;
          
          // Update UI with session config
          updateUIWithConfig(config);
          
          console.log('Loaded config for session ' + session + ':', config);
        } else {
          // No session-specific config, use default
          if (!sessionConfigs[session]) {
            sessionConfigs[session] = loopConfig;
            currentConfig = loopConfig;
            updateUIWithConfig(loopConfig);
          }
        }
      } catch (error) {
        console.error('Failed to load config for session ' + session + ':', error);
      }
    }
    
    // Update UI fields with config values
    function updateUIWithConfig(config) {
      // Use a flag to prevent redundant updates
      console.log('Updating UI with config:', config);
      
      // Basic settings
      setElementValue('custom-name', config.customName || '');
      console.log('[Config Debug] workingDirectory:', config.workingDirectory);
      setElementValue('working-directory', config.workingDirectory || '');
      setElementValue('delay-minutes', config.delayMinutes || 10);
      setElementValue('start-with-delay', config.startWithDelay !== false, 'checked');
      setElementValue('context-aware', config.contextAware !== false, 'checked');
      // Context thresholds are now hardcoded constants
      setElementValue('use-start-time', config.useStartTime === true, 'checked');
      setElementValue('start-time', config.startTime || '09:00');
      setElementValue('custom-message', config.customMessage || '');
      setElementValue('enable-log-rotation', config.enableLogRotation !== false, 'checked');
      setElementValue('max-log-size', (config.maxLogSize || 1048576) / (1024 * 1024));
      setElementValue('log-refresh-rate', config.logRefreshRate || 10);
      
      // Update the current log refresh rate
      currentLogRefreshRate = config.logRefreshRate || 10;
      
      // Conditional messages
      if (config.conditionalMessages) {
        const cm = config.conditionalMessages;
        
        // Morning message
        setElementValue('morning-enabled', cm.morningMessage?.enabled || false, 'checked');
        setElementValue('morning-start', cm.morningMessage?.startHour || 6);
        setElementValue('morning-end', cm.morningMessage?.endHour || 12);
        setElementValue('morning-message', cm.morningMessage?.message || '');
        
        // Afternoon message
        setElementValue('afternoon-enabled', cm.afternoonMessage?.enabled || false, 'checked');
        setElementValue('afternoon-start', cm.afternoonMessage?.startHour || 12);
        setElementValue('afternoon-end', cm.afternoonMessage?.endHour || 18);
        setElementValue('afternoon-message', cm.afternoonMessage?.message || '');
        
        // Evening message
        setElementValue('evening-enabled', cm.eveningMessage?.enabled || false, 'checked');
        setElementValue('evening-start', cm.eveningMessage?.startHour || 18);
        setElementValue('evening-end', cm.eveningMessage?.endHour || 23);
        setElementValue('evening-message', cm.eveningMessage?.message || '');
        
        // Standard message
        setElementValue('standard-enabled', cm.standardMessage?.enabled || false, 'checked');
        setElementValue('standard-message', cm.standardMessage?.message || '');
        
        // Low context message
        setElementValue('low-context-enabled', cm.lowContextMessage?.enabled || false, 'checked');
        setElementValue('low-context-threshold', cm.lowContextMessage?.threshold || 30);
        setElementValue('low-context-message', cm.lowContextMessage?.message || '');
        setElementValue('auto-compact-enabled', cm.lowContextMessage?.autoCompact || false, 'checked');
        setElementValue('auto-finish-enabled', cm.lowContextMessage?.autoFinish || false, 'checked');
        
        // After compact message
        setElementValue('after-compact-enabled', cm.afterCompactMessage?.enabled || false, 'checked');
        setElementValue('after-compact-lines', cm.afterCompactMessage?.linesAfterCompact || 50);
        setElementValue('after-compact-message', cm.afterCompactMessage?.message || '');
      }
      
      // Schedule
      if (config.schedule) {
        setElementValue('schedule-enabled', config.schedule.enabled === true, 'checked');
        // Also update the visibility of schedule settings
        const scheduleSettings = document.getElementById('schedule-settings');
        if (scheduleSettings) {
          scheduleSettings.style.display = config.schedule.enabled ? 'block' : 'none';
        }
        if (config.schedule.minutes && Array.isArray(config.schedule.minutes)) {
          scheduleMinutes = [...config.schedule.minutes];
          updateTimeline();
        }
      } else {
        setElementValue('schedule-enabled', false, 'checked');
      }
      
      // Trigger UI updates
      updateContextSettings();
      updateStartTimeSettings();
      updateScheduleSettings();
      updateConditionalConfig();
    }
    
    
    // Update loop status display
    async function updateLoopStatus() {
      try {
        const response = await fetch('/api/status');
        const status = await response.json();
        
        const statusIndicator = document.getElementById('status-indicator');
        const statusText = document.getElementById('status-text');
        
        // Check if current session has a loop running
        const currentSessionHasLoop = status.sessions && status.sessions.includes(currentSession);
        
        // Update our tracking variable for auto-compact/auto-pause
        isLoopRunningAndNotPaused = currentSessionHasLoop && !status.paused;
        
        // Update main status display
        if (currentSessionHasLoop) {
          statusIndicator.className = 'status-indicator running';
          
          // Check for countdown info
          if (status.loopDetails && status.loopDetails[currentSession]) {
            const loopDetail = status.loopDetails[currentSession];
            // Check pause status first
            if (loopDetail.paused) {
              statusText.innerHTML = 'Loop: <span style="color: var(--warning);">Paused</span> for ' + currentSession;
              if (loopDetail.timeRemaining) {
                const minutes = Math.floor(loopDetail.timeRemaining / 60000);
                const seconds = Math.floor((loopDetail.timeRemaining % 60000) / 1000);
                statusText.innerHTML += ' <span style="color: var(--text-secondary);">| ' + minutes + ':' + seconds.toString().padStart(2, '0') + ' remaining</span>';
              }
            } else if (loopDetail.nextMessageTime) {
              const now = new Date();
              const nextTime = new Date(loopDetail.nextMessageTime);
              const timeUntilNext = nextTime - now;
              
              if (timeUntilNext > 0) {
                const minutes = Math.floor(timeUntilNext / 60000);
                const seconds = Math.floor((timeUntilNext % 60000) / 1000);
                statusText.innerHTML = 'Loop: Running for ' + currentSession + ' <span style="color: var(--primary);">| Next in ' + minutes + ':' + seconds.toString().padStart(2, '0') + '</span>';
              } else {
                statusText.textContent = 'Loop: Running for ' + currentSession + ' | Sending...';
              }
            } else {
              statusText.textContent = 'Loop: Running for ' + currentSession;
            }
          } else {
            statusText.textContent = 'Loop: Running for ' + currentSession;
          }
        } else {
          statusIndicator.className = 'status-indicator stopped';
          statusText.textContent = 'Loop: Stopped for ' + currentSession;
        }
        
        // Add global status info if other loops are running
        if (status.count > 0) {
          statusText.textContent += ' (' + status.count + ' total)';
        }
        
        // Update button states based on current session
        const startBtn = document.getElementById('horizontal-start-btn');
        const stopBtn = document.getElementById('horizontal-stop-btn');
        const pauseBtn = document.getElementById('horizontal-pause-btn');
        const resumeBtn = document.getElementById('horizontal-resume-btn');
        const stopAllLoopsBtn = document.getElementById('stop-all-loops-btn');
        const stopAllSessionsBtn = document.getElementById('stop-all-sessions-btn');
        
        if (startBtn) startBtn.disabled = currentSessionHasLoop;
        if (stopBtn) stopBtn.disabled = !currentSessionHasLoop;
        if (pauseBtn) pauseBtn.disabled = !currentSessionHasLoop || status.paused;
        if (resumeBtn) resumeBtn.disabled = !currentSessionHasLoop || !status.paused;
        if (stopAllLoopsBtn) stopAllLoopsBtn.disabled = status.count === 0;
        if (stopAllSessionsBtn) {
          // Check if any tmux sessions exist
          fetch('/api/sessions')
            .then(res => res.json())
            .then(sessions => {
              stopAllSessionsBtn.disabled = sessions.length === 0;
            })
            .catch(() => {
              stopAllSessionsBtn.disabled = false;
            });
        }
        
      } catch (error) {
        console.error('Failed to update status:', error);
      }
    }
    
    // Wait for DOM to be ready before attaching event listeners and loading config
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initializeDashboard);
    } else {
      // DOM is already ready
      initializeDashboard();
    }
    
    async function initializeDashboard() {
      // First, load available tmux sessions to populate the dropdown
      await loadTmuxSessions();
      
      // Now get the actual selected session from the dropdown
      const sessionSelect = document.getElementById('session-select');
      if (sessionSelect && sessionSelect.value) {
        currentSession = sessionSelect.value;
        console.log('Initial session from dropdown:', currentSession);
        
        // Update kill button text
        const killBtnText = document.getElementById('kill-tmux-session-name');
        if (killBtnText) {
          killBtnText.textContent = currentSession;
        }
      }
      
      // Load initial config for the correct session
      try {
        await loadInitialConfig();
        console.log('Config loaded, setting up UI...');
      } catch (error) {
        console.error('Error loading config during init:', error);
      }
      
      // Now set up event listeners after config is loaded
      // Event listeners
      document.getElementById('context-aware').addEventListener('change', () => {
        updateContextSettings();
        autoSave(true);
      });
      document.getElementById('schedule-enabled').addEventListener('change', () => {
        updateScheduleSettings();
        autoSave(true);
      });
      document.getElementById('use-start-time').addEventListener('change', () => {
        updateStartTimeSettings();
        autoSave(true);
      });
      
      // Update loop status
      updateLoopStatus();
      
      // Set up periodic status updates
      setInterval(updateLoopStatus, 1000); // Update every second for countdown
      
      // Add event listener for new session button
      const newSessionBtn = document.getElementById('new-session-btn');
      if (newSessionBtn) {
        newSessionBtn.addEventListener('click', async () => {
          console.log('New Session button clicked');
          try {
            // Simple inline implementation
            const sessions = Array.from(document.getElementById('session-select').options).map(opt => opt.value);
            console.log('Current sessions:', sessions);
            
            const loopSessions = sessions.filter(s => s.startsWith('claude-loop'));
            const numbers = loopSessions.map(s => {
              // Use bracket notation which works, or manual extraction as fallback
              const match = s.match(/claude-loop([0-9]+)/);
              if (match) {
                return parseInt(match[1]);
              }
              // Fallback: manual extraction
              const num = s.replace('claude-loop', '');
              return parseInt(num) || 0;
            });
            console.log('Existing loop numbers:', numbers);
            
            let nextNum = 1;
            while (numbers.includes(nextNum)) nextNum++;
            const newSessionName = 'claude-loop' + nextNum;
            console.log('Will create session:', newSessionName);
            
            // Show creating message
            const logsEl = document.getElementById('logs');
            if (logsEl) {
              logsEl.innerHTML = '<span style="color: var(--success);">✅ Creating session: ' + newSessionName + '...</span>';
            }
            
            // Create the session
            console.log('Calling /api/tmux-setup...');
            const response = await fetch('/api/tmux-setup', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                session: newSessionName, 
                action: 'create' 
              })
            });
            
            console.log('Response status:', response.status);
            
            if (response.ok) {
              const result = await response.json();
              console.log('Session created:', result);
              
              // Reload page after delay
              setTimeout(() => {
                window.location.reload();
              }, 1500);
            } else {
              const errorText = await response.text();
              console.error('Failed to create session:', errorText);
              alert('Failed to create session: ' + errorText);
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
      
      // Add keyboard shortcuts when log pane has focus
      const logPane = document.getElementById('logs');
      let logPaneFocused = false;
      
      // Make log pane focusable
      logPane.setAttribute('tabindex', '0');
      logPane.style.outline = 'none'; // Remove default focus outline
      
      // Track focus state
      logPane.addEventListener('focus', () => {
        logPaneFocused = true;
        logPane.style.border = '2px solid var(--primary)';
        // Show a hint that keyboard shortcuts are active
        const hint = document.createElement('div');
        hint.id = 'keyboard-hint';
        hint.style.cssText = 'position: absolute; top: 5px; right: 5px; background: var(--primary); color: white; padding: 2px 8px; border-radius: 4px; font-size: 11px; z-index: 100;';
        hint.textContent = 'Keyboard shortcuts active';
        logPane.style.position = 'relative';
        logPane.appendChild(hint);
      });
      
      logPane.addEventListener('blur', () => {
        logPaneFocused = false;
        logPane.style.border = '1px solid var(--border)';
        const hint = document.getElementById('keyboard-hint');
        if (hint) hint.remove();
      });
      
      // Add click handler to focus
      logPane.addEventListener('click', () => {
        logPane.focus();
      });
      
      // Also track focus on custom message field
      const customMessageField = document.getElementById('custom-message');
      let customMessageFocused = false;
      
      customMessageField.addEventListener('focus', () => {
        customMessageFocused = true;
      });
      
      customMessageField.addEventListener('blur', () => {
        customMessageFocused = false;
      });
      
      document.addEventListener('keydown', async (e) => {
        // Handle Shift+Tab for mode toggle (works globally)
        if (e.shiftKey && e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          toggleMode();
          return;
        }
        
        // Process remaining shortcuts only if log pane OR custom message field is focused
        if (!logPaneFocused && !customMessageFocused) return;
        
        // Get the currently selected session
        const currentSession = document.getElementById('session-select').value;
        if (!currentSession) return;
        
        // Handle keyboard shortcuts
        if (e.ctrlKey) {
          let keyToSend = null;
          
          switch(e.key.toLowerCase()) {
            case 'd':
              keyToSend = 'C-d';
              break;
            case 'z':
              // Only send Ctrl+Z if log pane is focused (not message box)
              if (logPaneFocused && !customMessageFocused) {
                keyToSend = 'C-z';
              }
              break;
            case 'enter':
              keyToSend = 'Enter';
              break;
            case 'arrowup':
              keyToSend = 'Up';
              e.preventDefault(); // Prevent page scroll
              break;
            case 'arrowdown':
              keyToSend = 'Down';
              e.preventDefault(); // Prevent page scroll
              break;
            case 'arrowleft':
              // Skip if in custom message field (allow normal text navigation)
              if (!customMessageFocused) {
                keyToSend = 'Left';
              }
              break;
            case 'arrowright':
              // Skip if in custom message field (allow normal text navigation)
              if (!customMessageFocused) {
                keyToSend = 'Right';
              }
              break;
          }
          
          if (keyToSend) {
            e.preventDefault();
            // Visual feedback - highlight the button
            const buttonMap = {
              'C-d': 'Ctrl+D',
              'C-z': 'Ctrl+Z',
              'Enter': 'Enter',
              'Up': '↑',
              'Down': '↓',
              'Left': '←',
              'Right': '→'
            };
            
            const buttons = document.querySelectorAll('.vk-button');
            buttons.forEach(btn => {
              if (btn.textContent === buttonMap[keyToSend]) {
                btn.style.background = 'var(--primary)';
                btn.style.color = 'white';
                setTimeout(() => {
                  btn.style.background = 'var(--bg-secondary)';
                  btn.style.color = 'var(--text-primary)';
                }, 200);
              }
            });
            
            await sendKey(keyToSend);
          }
        } else if (!e.ctrlKey && !e.altKey && !e.metaKey) {
          // Handle non-modifier keys
          let keyToSend = null;
          
          switch(e.key) {
            case 'Escape':
              keyToSend = 'Escape';
              break;
            case 'Tab':
              keyToSend = 'Tab';
              e.preventDefault(); // Prevent default tab behavior
              break;
            // Arrow keys now require Ctrl (handled above)
          }
          
          if (keyToSend) {
            // Visual feedback
            const buttons = document.querySelectorAll('.vk-button');
            buttons.forEach(btn => {
              if (btn.textContent === e.key || 
                  (e.key === 'Escape' && btn.textContent === 'Esc') ||
                  (e.key === 'ArrowUp' && btn.textContent === '↑') ||
                  (e.key === 'ArrowDown' && btn.textContent === '↓') ||
                  (e.key === 'ArrowLeft' && btn.textContent === '←') ||
                  (e.key === 'ArrowRight' && btn.textContent === '→')) {
                btn.style.background = 'var(--primary)';
                btn.style.color = 'white';
                setTimeout(() => {
                  btn.style.background = 'var(--bg-secondary)';
                  btn.style.color = 'var(--text-primary)';
                }, 200);
              }
            });
            
            await sendKey(keyToSend);
          }
        }
      });
      
      // Handle regular key presses when log pane is focused
      document.addEventListener('keypress', (e) => {
        // Only redirect if log pane is focused and it's not a special key
        if (!logPaneFocused) return;
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        
        // Don't redirect if already typing in an input
        const activeElement = document.activeElement;
        if (activeElement && (
          activeElement.tagName === 'INPUT' || 
          activeElement.tagName === 'TEXTAREA' ||
          activeElement.tagName === 'SELECT'
        )) return;
        
        // Redirect the keypress to custom message field
        e.preventDefault();
        customMessageField.focus();
        
        // Add a brief visual flash to show input is being redirected
        customMessageField.style.borderColor = 'var(--primary)';
        setTimeout(() => {
          customMessageField.style.borderColor = '';
        }, 100);
        
        // Insert the character at cursor position
        const start = customMessageField.selectionStart;
        const end = customMessageField.selectionEnd;
        const text = customMessageField.value;
        const char = e.key;
        
        customMessageField.value = text.substring(0, start) + char + text.substring(end);
        customMessageField.selectionStart = customMessageField.selectionEnd = start + 1;
        
        // Trigger input event for any listeners
        customMessageField.dispatchEvent(new Event('input', { bubbles: true }));
      });
      
      // Initialize - removed duplicate loadConfig call
      // Small delay to ensure DOM updates are complete
      setTimeout(() => {
        // Add auto-save to all inputs after config is loaded
        const inputs = document.querySelectorAll('input, textarea, select');
        console.log('Found', inputs.length, 'inputs to add auto-save to');
        inputs.forEach(input => {
          // Skip if already has auto-save
          if (input.dataset.autoSaveAdded) {
            return;
          }
          
          // Skip the custom message field - it's for one-time messages, not config
          if (input.id === 'custom-message') {
            return;
          }
          
          // Mark as having auto-save
          input.dataset.autoSaveAdded = 'true';
          
          if (input.type === 'checkbox' || input.type === 'radio') {
            input.addEventListener('change', () => autoSave(true));
          } else {
            // For text inputs, add a per-input debounce
            let inputTimeout;
            input.addEventListener('input', () => {
              clearTimeout(inputTimeout);
              inputTimeout = setTimeout(() => {
                autoSave(false);
              }, 500); // Wait 500ms after user stops typing in this specific input
            });
          }
        });
      }, 200); // Increased delay slightly
      
      // Start intervals to update displays
      updateLoopStatus();
      updateContext();
      updateLogs();
      // Sessions already loaded at the beginning of initializeDashboard
      
      // Auto-refresh
      window.monitorStatusCheckCounter = 0;
      statusInterval = setInterval(() => {
        updateLoopStatus();
        updateContext();
        
        // Only check monitor status every 10 seconds unless monitor is running
        window.monitorStatusCheckCounter++;
        if (isMonitorRunning || window.monitorStatusCheckCounter >= 10) {
          updateMonitorStatus();
          window.monitorStatusCheckCounter = 0;
        }
      }, 1000); // Update every second for smooth countdown
      
      // Use the loaded refresh rate value
      console.log('Starting log refresh with rate:', currentLogRefreshRate, 'seconds');
      logInterval = setInterval(updateLogs, currentLogRefreshRate * 1000);
      
      // Add interaction event listeners to logs element
      const logsEl = document.getElementById('logs');
      if (logsEl) {
        // Detect mouse down - pause immediately
        logsEl.addEventListener('mousedown', (e) => {
          // Only pause for left mouse button
          if (e.button === 0) {
            isMouseDown = true;
            pauseLogUpdates('clicking/selecting');
          }
        });
        
        // Detect mouse up
        logsEl.addEventListener('mouseup', (e) => {
          if (e.button === 0) {
            isMouseDown = false;
            // Only resume if no text is selected
            if (!hasTextSelected()) {
              resumeLogUpdates();
            }
          }
        });
        
        // Also handle mouse leave (in case user drags outside)
        logsEl.addEventListener('mouseleave', (e) => {
          // Check if mouse is still down when leaving
          if (e.buttons === 1) {
            // Left button is still pressed, keep paused
            pauseLogUpdates('selecting outside logs');
          }
        });
        
        // Global mouseup in case user releases outside logs element
        document.addEventListener('mouseup', (e) => {
          if (e.button === 0 && isMouseDown) {
            isMouseDown = false;
            // Check if we should resume
            if (!hasTextSelected()) {
              resumeLogUpdates();
            }
          }
        });
        
        // Detect selection changes
        document.addEventListener('selectionchange', () => {
          if (hasTextSelected()) {
            pauseLogUpdates('text selected');
          } else if (isUserInteracting && !isMouseDown) {
            resumeLogUpdates();
          }
        });
        
        // Detect copy events
        logsEl.addEventListener('copy', () => {
          pauseLogUpdates('copying');
          // Don't immediately resume - wait for user to finish
        });
        
        // Detect when user clicks outside logs (deselect)
        document.addEventListener('click', (e) => {
          if (!logsEl.contains(e.target) && isUserInteracting && !isMouseDown) {
            resumeLogUpdates();
          }
        });
      }
      
      // Make functions available globally for inline event handlers
      window.handleMessageKeyDown = handleMessageKeyDown;
      window.sendMessage = sendMessage;
      
      // Auto-resize textareas
      function autoResizeTextarea(textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
      }
      
      // Apply auto-resize to all textareas with the auto-resize class
      const autoResizeTextareas = document.querySelectorAll('textarea.auto-resize');
      autoResizeTextareas.forEach(textarea => {
        // Set initial height
        autoResizeTextarea(textarea);
        
        // Auto-resize on input
        textarea.addEventListener('input', () => autoResizeTextarea(textarea));
        
        // Also resize on focus in case content was set programmatically
        textarea.addEventListener('focus', () => autoResizeTextarea(textarea));
      });
      
      // Also handle the custom message textarea at the bottom
      const customMessageTextarea = document.getElementById('custom-message');
      if (customMessageTextarea) {
        customMessageTextarea.addEventListener('input', () => autoResizeTextarea(customMessageTextarea));
        
        // Add paste event handler for files
        customMessageTextarea.addEventListener('paste', async (event) => {
          const items = event.clipboardData.items;
          
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            
            // Check if it's a file
            if (item.kind === 'file') {
              event.preventDefault(); // Prevent default paste behavior
              
              const file = item.getAsFile();
              if (!file) continue;
              
              console.log('Pasted file:', file.name, 'Type:', file.type);
              
              // Show uploading status
              const statusText = document.getElementById('status-text');
              const originalText = statusText.textContent;
              statusText.textContent = '📤 Uploading ' + file.name + '...';
              
              try {
                // Read file as base64
                const reader = new FileReader();
                reader.onload = async (e) => {
                  const base64Content = e.target.result.split(',')[1]; // Remove data:type;base64, prefix
                  
                  // Upload file to server
                  const response = await fetch('/api/upload-file', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      filename: file.name,
                      content: base64Content,
                      type: file.type
                    })
                  });
                  
                  if (response.ok) {
                    const result = await response.json();
                    
                    // Insert file path into textarea
                    const textarea = event.target;
                    const start = textarea.selectionStart;
                    const end = textarea.selectionEnd;
                    const text = textarea.value;
                    
                    // Add file path with a message
                    const fileMessage = '[File uploaded: ' + result.filePath + ']';
                    textarea.value = text.substring(0, start) + fileMessage + text.substring(end);
                    
                    // Move cursor after the inserted text
                    textarea.selectionStart = textarea.selectionEnd = start + fileMessage.length;
                    
                    statusText.textContent = '✅ Uploaded: ' + file.name;
                    setTimeout(() => {
                      statusText.textContent = originalText;
                    }, 3000);
                  } else {
                    throw new Error('Upload failed');
                  }
                };
                
                reader.onerror = () => {
                  statusText.textContent = '❌ Failed to read file';
                  setTimeout(() => {
                    statusText.textContent = originalText;
                  }, 3000);
                };
                
                reader.readAsDataURL(file);
              } catch (error) {
                console.error('Upload error:', error);
                statusText.textContent = '❌ Upload failed';
                setTimeout(() => {
                  statusText.textContent = originalText;
                }, 3000);
              }
              
              break; // Only handle first file
            }
          }
        });
        
        // Add drag and drop support
        customMessageTextarea.addEventListener('dragover', (event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          customMessageTextarea.style.background = 'var(--bg-tertiary)';
        });
        
        customMessageTextarea.addEventListener('dragleave', (event) => {
          event.preventDefault();
          customMessageTextarea.style.background = 'var(--bg-secondary)';
        });
        
        customMessageTextarea.addEventListener('drop', async (event) => {
          event.preventDefault();
          customMessageTextarea.style.background = 'var(--bg-secondary)';
          
          const files = event.dataTransfer.files;
          if (files.length === 0) return;
          
          const file = files[0];
          console.log('Dropped file:', file.name, 'Path:', file.path);
          
          // Get the file path - this only works in Electron apps or with special browser flags
          // For regular browsers, we'll need to use the File System Access API or upload the file
          let filePath = '';
          
          // Try to get the path from various sources
          if (file.path) {
            // Electron or some browsers expose this
            filePath = file.path;
          } else if (event.dataTransfer.items && event.dataTransfer.items[0].getAsFileSystemHandle) {
            // File System Access API (requires user permission)
            try {
              const handle = await event.dataTransfer.items[0].getAsFileSystemHandle();
              if (handle.kind === 'file') {
                // This gives us the name but not the full path in most browsers
                filePath = handle.name;
                console.log('File handle:', handle);
              }
            } catch (err) {
              console.log('Could not get file handle:', err);
            }
          }
          
          // If we couldn't get the path, show a message
          if (!filePath || filePath === file.name) {
            // For security reasons, browsers don't expose full file paths
            // Let's add a helpful message with the filename
            const textarea = event.target;
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const text = textarea.value;
            
            // Add just the filename as browsers don't expose full paths
            const fileMessage = '[File: ' + file.name + ' (drag from file manager to get full path)]';
            textarea.value = text.substring(0, start) + fileMessage + text.substring(end);
            
            // Move cursor after the inserted text
            textarea.selectionStart = textarea.selectionEnd = start + fileMessage.length;
            
            // Show a note in status
            const statusText = document.getElementById('status-text');
            const originalText = statusText.textContent;
            statusText.textContent = '📁 Added filename (full path not available in browser)';
            setTimeout(() => {
              statusText.textContent = originalText;
            }, 3000);
          } else {
            // We got a full path!
            const textarea = event.target;
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const text = textarea.value;
            
            // Add the full file path
            const fileMessage = filePath;
            textarea.value = text.substring(0, start) + fileMessage + text.substring(end);
            
            // Move cursor after the inserted text
            textarea.selectionStart = textarea.selectionEnd = start + fileMessage.length;
            
            // Show success in status
            const statusText = document.getElementById('status-text');
            const originalText = statusText.textContent;
            statusText.textContent = '✅ Added file path: ' + file.name;
            setTimeout(() => {
              statusText.textContent = originalText;
            }, 3000);
          }
        });
      }
    } // End of initializeDashboard function
    
    // Stop Claude function (only stops Claude, keeps tmux alive)
    async function stopClaude() {
      try {
        // Make sure we have the current session from the dropdown
        const sessionSelect = document.getElementById('session-select');
        const targetSession = sessionSelect ? sessionSelect.value : currentSession;
        
        console.log('Stopping Claude in session:', targetSession);
        
        // Send Ctrl+C to the correct session
        await fetch('/api/send-key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            session: targetSession,
            key: 'C-c'
          })
        });
        
        // Small delay
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Send it again (Claude sometimes needs it twice)
        await fetch('/api/send-key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            session: targetSession,
            key: 'C-c'
          })
        });
        
        // Show success message
        const tempMsg = document.createElement('div');
        tempMsg.style.cssText = 'position: fixed; top: 20px; right: 20px; background: var(--success); color: white; padding: 10px 20px; border-radius: 4px; z-index: 1000;';
        tempMsg.textContent = 'Claude stopped (tmux session and logging still active)';
        document.body.appendChild(tempMsg);
        setTimeout(() => tempMsg.remove(), 3000);
        
        console.log('Claude stop command sent successfully');
      } catch (error) {
        console.error('Failed to stop Claude:', error);
        alert('Failed to stop Claude: ' + error.message);
      }
    }
    
    // Kill tmux session function
    async function killTmuxSession() {
      try {
        if (!confirm('This will kill the entire tmux session "' + currentSession + '".\\n\\nThis cannot be undone.\\n\\nContinue?')) {
          return;
        }
        
        // Kill the tmux session
        await fetch('/api/kill-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            session: currentSession
          })
        });
        
        // Clear the form to prevent overwriting claude-loop1 settings
        clearConfigForm();
        
        // Refresh the session list after a short delay
        setTimeout(() => {
          loadTmuxSessions();
          updateCurrentConversation();
        }, 1500);
        
        // Show success message
        const successMsg = document.createElement('div');
        successMsg.style.cssText = 'position: fixed; top: 20px; right: 20px; background: var(--success); color: white; padding: 10px 20px; border-radius: 4px; z-index: 1000;';
        successMsg.textContent = 'Tmux session killed';
        document.body.appendChild(successMsg);
        setTimeout(() => successMsg.remove(), 3000);
      } catch (error) {
        console.error('Failed to kill tmux session:', error);
        alert('Failed to kill tmux session: ' + error.message);
      }
    }
    
    // Clear the config form (to prevent settings persistence bug)
    function clearConfigForm() {
      const defaults = {
        customName: '',
        delayMinutes: 10,
        startWithDelay: true,
        useStartTime: false,
        startTime: '09:00',
        contextAware: true,
        customMessage: '',
        enableLogRotation: true,
        maxLogSize: 1048576,
        messageHistory: []
      };
      
      document.getElementById('custom-name').value = defaults.customName;
      document.getElementById('delay-minutes').value = defaults.delayMinutes;
      document.getElementById('start-with-delay').checked = defaults.startWithDelay;
      document.getElementById('use-start-time').checked = defaults.useStartTime;
      document.getElementById('start-time').value = defaults.startTime;
      document.getElementById('context-aware').checked = defaults.contextAware;
      document.getElementById('custom-message').value = defaults.customMessage;
      document.getElementById('enable-log-rotation').checked = defaults.enableLogRotation;
      document.getElementById('max-log-size').value = defaults.maxLogSize;
    }
    
    // Start New Claude Session function
    async function restartSession() {
      try {
        const workingDir = document.getElementById('working-directory').value || HOME_DIR;
        
        // Send Ctrl+C twice to ensure Claude exits
        await sendKey('C-c');
        await new Promise(resolve => setTimeout(resolve, 500));
        await sendKey('C-c');
        
        // Wait a bit longer for Claude to fully exit
        setTimeout(async () => {
          // Then proceed with restart
          setTimeout(async () => {
            // Send cd command to change directory
            await fetch('/api/send-custom-message', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                session: currentSession,
                message: 'cd ' + workingDir
              })
            });
            
            // Start Claude again
            setTimeout(async () => {
              await fetch('/api/send-custom-message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                  session: currentSession,
                  message: 'claude'
                })
              });
              
              // Wait for Claude to start
              setTimeout(async () => {
                // Send /help to trigger conversation file creation
                await fetch('/api/send-custom-message', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ 
                    session: currentSession,
                    message: '/help'
                  })
                });
                
                // Wait for conversation file to be created
                setTimeout(async () => {
                  // Track the new conversation
                  await fetch('/api/conversation/track', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                      session: currentSession
                    })
                  });
                  
                  // Refresh the conversation list to show the new tracked conversation
                  if (window.refreshConversationList) {
                    await window.refreshConversationList();
                  }
                  
                  // Show success message
                  const tempMsg = document.createElement('div');
                  tempMsg.style.cssText = 'position: fixed; top: 20px; right: 20px; background: var(--success); color: white; padding: 10px 20px; border-radius: 4px; z-index: 1000;';
                  tempMsg.textContent = 'New Claude session started and tracked';
                  document.body.appendChild(tempMsg);
                  setTimeout(() => tempMsg.remove(), 3000);
                }, 3000); // Wait 3 seconds for file creation
              }, 2000); // Wait 2 seconds for Claude to start
            }, 500);
            
          }, 1000);
          
        }, 500);
        
      } catch (error) {
        console.error('Failed to restart session:', error);
      }
    }
    
    // Send key to tmux
    async function sendKey(key) {
      try {
        await fetch('/api/send-key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            session: currentSession,
            key: key
          })
        });
      } catch (error) {
        console.error('Failed to send key:', error);
      }
    }
    
    // Restart and Resume Session function
    async function restartAndResumeSession() {
      try {
        if (!confirm('This will kill the current Claude session and restart with --resume.\\n\\nAny unsaved conversation will be lost.\\n\\nContinue?')) {
          return;
        }
        
        const workingDir = document.getElementById('working-directory').value || HOME_DIR;
        
        // Show status
        const logsEl = document.getElementById('logs');
        if (logsEl) {
          logsEl.innerHTML = '<span style="color: var(--warning);">🔄 Restarting session with resume...</span>';
        }
        
        // Stop the log monitor first
        await controlLogMonitor('stop');
        
        // Kill the current tmux session
        await fetch('/api/kill-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            session: currentSession
          })
        });
        
        // Wait a bit for session to be killed
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Create new session with resume
        const response = await fetch('/api/tmux-setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            session: currentSession,
            action: 'create'
          })
        });
        
        if (response.ok) {
          // Wait for session to be created
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Reload the page to refresh everything
          window.location.reload();
        } else {
          alert('Failed to restart session');
        }
        
      } catch (error) {
        console.error('Failed to restart and resume session:', error);
        alert('Failed to restart session: ' + error.message);
      }
    }
    
    // Toggle mode (sends Ctrl+Tab)
    async function toggleMode() {
      try {
        await fetch('/api/send-key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            session: currentSession,
            key: 'BTab'
          })
        });
      } catch (error) {
        console.error('Failed to toggle mode:', error);
      }
    }
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
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(dashboardHTML);
    return;
  }
  
  // Handle favicon request
  if (pathname === '/favicon.ico') {
    res.writeHead(204); // No content
    res.end();
    return;
  }
  
  res.writeHead(404);
  res.end('Not found');
});

// Initialize
loadConfig().then(async () => {
  // Initialize session tracker and matcher
  await sessionTracker.init();
  await sessionMatcher.init();
  
  // Restore active loops from persistent storage
  const activeLoops = await loadActiveLoops();
  for (const [session, info] of Object.entries(activeLoops)) {
    if (info.active) {
      console.log(`Restoring loop for session: ${session}${info.paused ? ' (paused)' : ''}`);
      try {
        // Load session-specific config
        const sessionConfigFile = path.join(__dirname, `loop-config-${session}.json`);
        const sessionConfigData = await fs.readFile(sessionConfigFile, 'utf-8');
        const sessionConfig = JSON.parse(sessionConfigData);
        await startLoop(session, sessionConfig);
        
        // Restore paused state if it was paused
        if (info.paused && sessionLoops.has(session)) {
          const loopInfo = sessionLoops.get(session);
          loopInfo.paused = true;
          console.log(`Restored paused state for session: ${session}`);
        }
      } catch (e) {
        console.error(`Failed to restore loop for ${session}:`, e);
      }
    }
  }
  
  server.listen(CONFIG.port, '0.0.0.0', () => {
    console.log('🎮 Claude Loop Unified Dashboard running at:');
    console.log('   - http://localhost:' + CONFIG.port);
    console.log('   - http://192.168.1.2:' + CONFIG.port);
    console.log('✨ Features:');
    console.log('   - Full configuration control');
    console.log('   - Real-time context monitoring');
    console.log('   - Custom messages on-the-fly');
    console.log('   - Start/stop/pause/resume');
    console.log('   - Persistent settings');
  });
  
  // Start periodic session matching (every 30 seconds)
  setInterval(async () => {
    try {
      // Get all unique working directories from active loops
      const workingDirs = new Set();
      for (const [session, loopInfo] of sessionLoops.entries()) {
        // Try to get working directory from session config
        try {
          const sessionConfigFile = path.join(__dirname, `loop-config-${session}.json`);
          const sessionConfig = JSON.parse(await fs.readFile(sessionConfigFile, 'utf-8'));
          const workingDir = sessionConfig.workingDirectory || process.cwd();
          workingDirs.add(workingDir);
        } catch (e) {
          // Default to current working directory
          workingDirs.add(process.cwd());
        }
      }
      
      // Run matcher for each working directory
      for (const workingDir of workingDirs) {
        await sessionMatcher.matchConversationsToSessions(workingDir);
      }
    } catch (err) {
      console.error('Error in session matching:', err);
    }
  }, 30000); // Run every 30 seconds
});