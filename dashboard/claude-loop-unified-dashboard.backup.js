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
const fsSync = require('fs');
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
        
      case '/api/conversation/current':
        // Get current conversation ID from most recent JSONL file
        try {
          const projectsDir = path.join(require('os').homedir(), '.claude', 'projects');
          
          // Try multiple project directories (current one first, then InfiniQuest)
          const projectPaths = [
            path.join(projectsDir, '-home-michael-InfiniQuest-tmp-claudeLoop-dashboard'),
            path.join(projectsDir, '-home-michael-InfiniQuest')
          ];
          
          let mostRecent = null;
          let mostRecentTime = 0;
          
          for (const projectPath of projectPaths) {
            try {
              const files = await fs.readdir(projectPath);
              const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
              
              // Check each file in this project directory
              for (const file of jsonlFiles) {
                const filePath = path.join(projectPath, file);
                const stats = await fs.stat(filePath);
                if (stats.mtime.getTime() > mostRecentTime) {
                  mostRecentTime = stats.mtime.getTime();
                  mostRecent = file.replace('.jsonl', '');
                }
              }
            } catch (e) {
              // Directory doesn't exist, continue to next
              continue;
            }
          }
          
          if (!mostRecent) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No conversations found' }));
            break;
          }
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ conversationId: mostRecent }));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
        break;
        
      case '/api/conversation/messages':
        const convId = parsedUrl.query.id;
        if (!convId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Conversation ID required' }));
          break;
        }
        
        try {
          const messages = await conversationReader.getLatestMessages(convId, 100);
          
          // Filter to ensure only messages with string content are sent
          const validMessages = messages.filter(msg => {
            if (!msg || typeof msg.content !== 'string') {
              console.log('Filtering out non-string message:', msg?.type, typeof msg?.content);
              return false;
            }
            return true;
          });
          
          console.log(`[API] Returning ${validMessages.length} valid messages out of ${messages.length} total`);
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(validMessages));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
        break;
        
      case '/api/tmux-tail':
        const tailLines = parsedUrl.query.lines ? parseInt(parsedUrl.query.lines) : 10;
        const tailSession = parsedUrl.query.session || 'claude-chat';
        
        try {
          // Get last N lines from tmux
          const { stdout } = await execAsync(`tmux capture-pane -t "${tailSession}:0.0" -p -e | tail -${tailLines}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ content: stdout }));
        } catch (error) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ content: '' }));
        }
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
// Import conversation reader
const ConversationReader = require('./conversation-reader.js');
const conversationReader = new ConversationReader();

// Load dashboard HTML from file
const dashboardHTMLPath = path.join(__dirname, 'dashboard.html');
let dashboardHTML = '';
try {
  dashboardHTML = fsSync.readFileSync(dashboardHTMLPath, 'utf8');
} catch (error) {
  console.error('Failed to load dashboard.html:', error);
  dashboardHTML = '<html><body><h1>Error: Failed to load dashboard</h1></body></html>';
}

// OLD TEMPLATE LITERAL REMOVED - Lines 1534-7391 deleted
// Now using separate files: dashboard.html, dashboard-main.js

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
  
  // Serve dashboard utilities
  if (pathname === '/dashboard-utils.js') {
    const utilsPath = path.join(__dirname, 'dashboard-utils.js');
    fs.readFile(utilsPath, 'utf8')
      .then(data => {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(data);
      })
      .catch(err => {
        console.error('Error serving dashboard-utils.js:', err);
        res.writeHead(404);
        res.end('Not found');
      });
    return;
  }
  
  // Serve dashboard styles
  if (pathname === '/dashboard-styles.css') {
    const stylesPath = path.join(__dirname, 'dashboard-styles.css');
    fs.readFile(stylesPath, 'utf8')
      .then(data => {
        res.writeHead(200, { 'Content-Type': 'text/css' });
        res.end(data);
      })
      .catch(err => {
        console.error('Error serving dashboard-styles.css:', err);
        res.writeHead(404);
        res.end('Not found');
      });
    return;
  }
  
  // Serve dashboard API module
  if (pathname === '/dashboard-api.js') {
    const apiPath = path.join(__dirname, 'dashboard-api.js');
    fs.readFile(apiPath, 'utf8')
      .then(data => {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(data);
      })
      .catch(err => {
        console.error('Error serving dashboard-api.js:', err);
        res.writeHead(404);
        res.end('Not found');
      });
    return;
  }
  
  // Serve dashboard main JavaScript
  if (pathname === '/dashboard-main.js') {
    const mainPath = path.join(__dirname, 'dashboard-main.js');
    fs.readFile(mainPath, 'utf8')
      .then(data => {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(data);
      })
      .catch(err => {
        console.error('Error serving dashboard-main.js:', err);
        res.writeHead(404);
        res.end('Not found');
      });
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
