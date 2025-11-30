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
const log = require('./dashboard-logging');
// Create a timeout-enabled exec function
const execAsyncWithTimeout = (cmd, options = {}) => {
  return new Promise((resolve, reject) => {
    exec(cmd, {
      maxBuffer: 1024 * 1024,
      timeout: 5000, // 5 second default timeout
      ...options
    }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
};

const execAsync = execAsyncWithTimeout;

// Get the user's home directory
const HOME_DIR = os.homedir();

// Initialize History Manager
const HistoryManager = require('./todo-utils/history-manager');
const historyManager = new HistoryManager();

// Configuration
const CONFIG = {
  port: process.env.PORT || 3335,
  logDir: path.join(__dirname, '../logs'),
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

// Import config utilities
const { getSessionConfig: getSessionConfigOriginal, saveSessionConfig: saveSessionConfigOriginal } = require('./config-utils.js');

// Session config cache (60 second TTL)
const configCache = new Map();
const CONFIG_CACHE_TTL = 60000; // 60 seconds

// Cached version of getSessionConfig
async function getSessionConfig(session, options) {
  const cacheKey = session;
  const cached = configCache.get(cacheKey);
  
  // Check if cache is valid
  if (cached && Date.now() - cached.timestamp < CONFIG_CACHE_TTL) {
    log.verbose(`[Cache] Using cached config for ${session}`);
    return cached.config;
  }
  
  // Load fresh config
  log.verbose(`[Cache] Loading fresh config for ${session}`);
  const config = await getSessionConfigOriginal(session, options);
  
  // Update cache
  configCache.set(cacheKey, {
    config,
    timestamp: Date.now()
  });
  
  return config;
}

// Wrapped saveSessionConfig that clears cache
async function saveSessionConfig(session, config) {
  // Clear cache for this session
  configCache.delete(session);
  log.verbose(`[Cache] Cleared cache for ${session} after save`);
  
  // Save the config
  return await saveSessionConfigOriginal(session, config);
}

// Import tmux utilities
const tmuxUtils = require('./tmux-utils.js');

// Import conversation auto-setup
const conversationAutoSetup = require('./conversation-auto-setup.js');

// Todo system configuration
const TODO_FILE = path.join(HOME_DIR, '.claude', 'todos.json');
let todos = [];

// Todo helper functions
async function loadTodos() {
  try {
    await fs.mkdir(path.dirname(TODO_FILE), { recursive: true });
    const data = await fs.readFile(TODO_FILE, 'utf8');
    todos = JSON.parse(data);
    
    // Migrate 'completed' status to 'user_approved' for consistency
    let migrated = false;
    todos.forEach(todo => {
      if (todo.status === 'completed') {
        todo.status = 'user_approved';
        migrated = true;
      }
    });
    
    // Save if we migrated any todos
    if (migrated) {
      await saveTodos();
    }
  } catch (error) {
    // File doesn't exist yet, start with empty array
    todos = [];
  }
  return todos;
}

async function saveTodos() {
  await fs.mkdir(path.dirname(TODO_FILE), { recursive: true });
  await fs.writeFile(TODO_FILE, JSON.stringify(todos, null, 2));
}

function generateTodoId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Context thresholds (hardcoded for visual indicators)
const contextWarningPercent = 20;
const contextCriticalPercent = 10;

// Default loop configuration
let loopConfig = {
  customName: "", // Custom display name for the loop
  // conversationId stored in individual config files
  delayMinutes: 10,
  startWithDelay: true, // Whether to wait for delay before first message
  useStartTime: false,
  startTime: "09:00",
  contextAware: true,
  autoCompactThreshold: 5, // Auto-compact when context drops below this percentage
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
  },
  reviewSettings: {
    enabled: false,
    reviewsBeforeNextTask: 1,
    reviewMessage: "Please review the work you just completed. Are there any improvements needed?",
    nextTaskMessage: "Work completed and reviewed. Please proceed to the next task."
  }
};

// Track active message send processes (for panic stop functionality)
const activeSendProcesses = new Map(); // session -> Set of child processes

// Execute shell command
async function execCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { 
      maxBuffer: 1024 * 1024,
      timeout: 5000 // 5 second timeout for all exec commands
    }, (error, stdout, stderr) => {
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
    log.info('Config saved to:', CONFIG.configFile);
  } catch (error) {
    log.error('Error saving config:', error);
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
            // Get complete config from single source
            const config = await getSessionConfig(session, { loopConfig });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(config));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(loopConfig));
          }
        } else if (method === 'POST') {
          const data = JSON.parse(body);
          if (data.session) {
            // Save everything to session config file (single source of truth)
            const updatedConfig = await saveSessionConfig(data.session, data.config || data);
            log.info('Config saved for session: ' + data.session);

            // Reset auto-accept debounce when auto-accept is enabled/re-enabled
            if (updatedConfig.autoAcceptPrompts) {
              if (!autoAcceptState.sessions[data.session]) {
                autoAcceptState.sessions[data.session] = {};
              }
              // Clear the debounce timer to allow immediate auto-accept
              autoAcceptState.sessions[data.session].lastAutoAcceptTime = null;
              log.info(`[Auto-Accept] Debounce reset for session ${data.session} due to config change`);
            }

            // If delay changed and loop is running, update the next message time
            const loopInfo = sessionLoops.get(data.session);
            if (loopInfo && !loopInfo.paused && updatedConfig.delayMinutes) {
              const oldDelay = loopInfo.delayMinutes || loopConfig.delayMinutes;
              const newDelay = updatedConfig.delayMinutes;
              
              if (oldDelay !== newDelay) {
                const now = Date.now();
                const newDelayMs = newDelay * 60 * 1000;
                
                // If "Start with full delay" is checked, reset to full delay
                // Otherwise, calculate based on time elapsed
                let timeRemainingWithNewDelay;
                if (updatedConfig.startWithDelay) {
                  // Reset to full new delay
                  timeRemainingWithNewDelay = newDelayMs;
                  log.debug(`Resetting timer to full ${newDelay} minutes (startWithDelay is enabled)`);
                } else {
                  // Calculate how much time has passed since last message
                  const timeSinceLastMessage = now - (loopInfo.lastMessageTime || loopInfo.startTime.getTime());
                  // Calculate remaining time with new delay
                  timeRemainingWithNewDelay = Math.max(0, newDelayMs - timeSinceLastMessage);
                  log.debug(`Adjusting timer based on ${Math.round(timeSinceLastMessage / 1000)}s elapsed`);
                }
                
                // Update the loop info
                loopInfo.delayMinutes = newDelay;
                loopInfo.nextMessageTime = new Date(now + timeRemainingWithNewDelay);
                
                // Clear old interval and create new one with updated delay
                clearInterval(loopInfo.intervalId);
                
                // Set new interval with the new delay
                loopInfo.intervalId = setInterval(async () => {
                  try {
                    // Check if schedule is active before sending message
                    const config = await getSessionConfig(data.session, { loopConfig });
                    if (!isScheduleActive(data.session, config)) {
                      log.debug(`Skipping message for ${data.session} - outside schedule window`);
                      // Still update next message time to keep countdown accurate
                      loopInfo.nextMessageTime = new Date(Date.now() + newDelayMs);
                      return;
                    }
                    
                    // Get conditional message or use custom message
                    const message = await getConditionalMessage(data.session) || config.customMessage;
                    if (message) {
                      await sendCustomMessage(message, data.session);
                      log.info('Sent message to session: ' + data.session);
                    } else {
                      log.debug(`No message to send for ${data.session}`);
                    }
                    
                    // Update last message time and next message time
                    loopInfo.lastMessageTime = Date.now();
                    loopInfo.nextMessageTime = new Date(Date.now() + newDelayMs);
                    
                  } catch (error) {
                    log.error('Loop error for session ' + data.session + ':', error);
                  }
                }, newDelayMs);
                
                log.info(`Updated running loop delay for ${data.session}: ${oldDelay} -> ${newDelay} minutes`);
                log.debug(`Next message in ${Math.round(timeRemainingWithNewDelay / 1000)} seconds`);
                
                // Save the updated loop state
                await saveActiveLoops();
              }
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, config: updatedConfig }));
          } else {
            // Save global config
            loopConfig = { ...loopConfig, ...data };
            await saveConfig();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          }
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
        
      case '/api/conversation/discover':
        // Discover latest conversation from Claude's filesystem
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
        const afterIndex = parsedUrl.query.after ? parseInt(parsedUrl.query.after) : null;
        const limit = parsedUrl.query.limit ? parseInt(parsedUrl.query.limit) : 100;
        
        // Log who's calling this API (commented out - req not available in this scope)
        // log.verbose(`[API] /conversation/messages called - id: ${convId}, limit: ${limit}`);
        
        if (!convId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Conversation ID required' }));
          break;
        }
        
        try {
          // If afterIndex is provided, get only new messages
          if (afterIndex !== null && afterIndex >= 0) {
            // Get the conversation file path
            const projectsDir = path.join(HOME_DIR, '.claude', 'projects');
            const possiblePaths = [
              path.join(projectsDir, '-home-michael-InfiniQuest', `${convId}.jsonl`),
              path.join(projectsDir, '-home-michael-InfiniQuest-tmp-claudeLoop', `${convId}.jsonl`),
              path.join(projectsDir, '-home-michael-InfiniQuest-tmp-claudeLoop-dashboard', `${convId}.jsonl`),
              path.join(projectsDir, '-home-michael-Test', `${convId}.jsonl`),
              path.join(projectsDir, '-home-michael', `${convId}.jsonl`),
              path.join(projectsDir, '-home-michael-ai-dev-review', `${convId}.jsonl`)
            ];
            
            let foundPath = null;
            for (const convPath of possiblePaths) {
              try {
                await fs.access(convPath);
                foundPath = convPath;
                break;
              } catch (e) {
                // Continue checking
              }
            }
            
            if (!foundPath) {
              throw new Error('Conversation file not found');
            }
            
            // Read the file and count lines
            const content = await fs.readFile(foundPath, 'utf8');
            const lines = content.split('\n').filter(line => line.trim());
            
            // Get only new messages (lines after afterIndex)
            const newMessages = [];
            for (let i = afterIndex + 1; i < lines.length; i++) {
              try {
                const msg = JSON.parse(lines[i]);
                // Convert to expected format
                const formatted = {
                  type: msg.type || (msg.role === 'user' ? 'user' : 'assistant'),
                  content: msg.message?.content || msg.content || '',
                  index: i
                };
                
                if (typeof formatted.content === 'string') {
                  newMessages.push(formatted);
                }
              } catch (e) {
                log.debug(`Skipping invalid JSON at line ${i}`);
              }
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
              messages: newMessages, 
              totalCount: lines.length,
              hasMore: false 
            }));
          } else {
            // Original behavior - get messages with limit
            const messages = await conversationReader.getLatestMessages(convId, limit);
            
            // Filter to ensure only messages with string content are sent
            const validMessages = messages.filter(msg => {
              if (!msg || typeof msg.content !== 'string') {
                log.debug('Filtering out non-string message:', msg?.type, typeof msg?.content);
                return false;
              }
              return true;
            });
            
            // Add index to each message
            validMessages.forEach((msg, i) => {
              msg.index = i;
            });
            
            log.debug(`[API] Returning ${validMessages.length} valid messages out of ${messages.length} total`);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(validMessages));
          }
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
        break;
        
      case '/api/client-error':
        if (method === 'POST') {
          let body = '';
          request.on('data', chunk => body += chunk);
          request.on('end', () => {
            try {
              const error = JSON.parse(body);
              log.error('[CLIENT ERROR]', new Date().toISOString(), error);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ logged: true }));
            } catch (e) {
              res.writeHead(400);
              res.end('Invalid JSON');
            }
          });
          return;
        }
        break;
        
      case '/api/tmux-tail':
        const tailLines = parsedUrl.query.lines ? parseInt(parsedUrl.query.lines) : 500;
        const tailSession = parsedUrl.query.session || 'claude-chat';
        const currentTab = parsedUrl.query.tab || 'tmux'; // Client can tell us which tab is active
        
        try {
          // Get last N lines from tmux (or all lines if tailLines is 0)
          const tailCommand = tailLines > 0 
            ? `tmux capture-pane -t "${tailSession}:0.0" -p -S -${tailLines} -e`
            : `tmux capture-pane -t "${tailSession}:0.0" -p -S - -e`;
          const { stdout } = await execAsync(tailCommand);
          
          // Quick keyword check on last 2000 chars to decide what analysis we need
          const last2000 = stdout.slice(-2000).toLowerCase();
          // Activity prompts are always at the very bottom - check last 500 chars only
          const last500 = stdout.slice(-500).toLowerCase();

          // Determine what kind of analysis is needed based on keywords
          const hints = {};
          let needsAnalysis = false;

          // Check for prompt keywords
          if (last2000.includes('do you want to proceed?') ||
              last2000.includes('❯') ||
              last2000.includes('make this edit?') ||
              last2000.includes('make these edits?')) {
            hints.checkPrompt = true;
            hints.skipContext = true;
            hints.skipCompact = true;
            needsAnalysis = true;
          }

          // Check for activity keywords - only need last 500 chars (bottom of screen)
          if (last500.includes('(esc)') || last500.includes('esc to interrupt')) {
            hints.checkActivity = true;
            needsAnalysis = true;
          }

          // Check for context keywords
          if (last2000.includes('%') && last2000.includes('context')) {
            hints.checkContext = true;
            needsAnalysis = true;
          }
          
          // If no keywords detected, skip analysis and return content with defaults
          if (!needsAnalysis) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
              content: stdout,
              contextPercent: null,
              interactivePrompt: null,
              isBusy: false
            }));
            return;
          }
          
          // Get unified analysis with hints about what to check
          const analysis = getAnalysis(stdout, tailSession, hints);
          
          // Extract what we need
          const { isBusy, contextPercent, interactivePrompt, hasCompactPhrase } = analysis;
          
          // Debug: Log if keywords were detected but prompt wasn't
          if (needsAnalysis && (!interactivePrompt || !interactivePrompt.detected)) {
            log.debug(`[Prompt Detection] Keywords found but no prompt detected for ${tailSession}`);
          }

          // Handle auto-accept if enabled and prompt detected
          if (interactivePrompt && interactivePrompt.detected) {
            log.info(`[Auto-Accept] Interactive prompt detected for ${tailSession}: ${interactivePrompt.type}`);
            
            // Get session config to check if auto-accept is enabled
            const sessionConfig = await getSessionConfig(tailSession, { loopConfig });
            log.debug(`[Auto-Accept] Config for ${tailSession}: autoAcceptPrompts=${sessionConfig.autoAcceptPrompts}`);
            
            // Check if loop is running (not just if checkbox is checked)
            const loopInfo = sessionLoops.get(tailSession);
            const isLoopRunning = loopInfo && !loopInfo.paused;

            log.info(`[Auto-Accept] Loop check for ${tailSession}: loopInfo=${!!loopInfo}, paused=${loopInfo?.paused}, isRunning=${isLoopRunning}`);

            // Check if auto-accept should work without loop
            const allowWithoutLoop = sessionConfig.autoAcceptWithoutLoop === true;

            if (sessionConfig.autoAcceptPrompts && !isLoopRunning && !allowWithoutLoop) {
              log.info(`[Auto-Accept] Checkbox is checked but loop is NOT running for ${tailSession}, skipping auto-accept (allowWithoutLoop=${allowWithoutLoop})`);
            } else if (sessionConfig.autoAcceptPrompts && (isLoopRunning || allowWithoutLoop)) {
              // Auto-accept works when: checkbox is checked AND (loop is running OR allowWithoutLoop is enabled)
              log.info(`[Auto-Accept] Auto-accept is enabled for ${tailSession} (loop running: ${isLoopRunning}, allowWithoutLoop: ${allowWithoutLoop})`);
              
              // Initialize auto-accept state for session if needed
              if (!autoAcceptState.sessions[tailSession]) {
                autoAcceptState.sessions[tailSession] = {
                  lastAutoAcceptTime: null
                };
              }
              
              const sessionState = autoAcceptState.sessions[tailSession];
              const now = Date.now();
              const timeSinceLastAccept = sessionState.lastAutoAcceptTime ?
                (now - sessionState.lastAutoAcceptTime) / 1000 / 60 : Infinity; // minutes

              // Use configurable cooldown (default 5 minutes, 0 = disabled)
              const autoAcceptDebounceMinutes = sessionConfig.autoAcceptCooldown !== undefined ?
                sessionConfig.autoAcceptCooldown : 5;
              
              if (timeSinceLastAccept >= autoAcceptDebounceMinutes) {
                // Only schedule a new timer if one isn't already pending
                // This prevents the timer from being reset on every poll
                if (autoAcceptTimers.has(tailSession)) {
                  log.debug(`[Auto-Accept] Timer already pending for ${tailSession}, skipping`);
                } else {
                  // Get the delay from config (default to 10 seconds)
                  const autoAcceptDelay = (sessionConfig.autoAcceptDelay || 10) * 1000; // Convert to milliseconds

                  log.info(`[Auto-Accept] Will send Enter to ${tailSession} after ${autoAcceptDelay/1000}s delay`);

                  // Delay before sending Enter to give user time to see the prompt
                  const timerId = setTimeout(async () => {
                    // Clean up timer reference
                    autoAcceptTimers.delete(tailSession);

                    try {
                      // Just send Enter - no need to re-verify (harmless if already answered)
                      log.info(`[Auto-Accept] Sending Enter to accept prompt for session ${tailSession}`);
                      await execAsync(`tmux send-keys -t "${tailSession}:0.0" Enter`);
                      sessionState.lastAutoAcceptTime = Date.now();

                      // Mark in the response that we auto-accepted
                      if (interactivePrompt) {
                        interactivePrompt.autoAccepted = true;
                        interactivePrompt.autoAcceptTime = new Date().toISOString();
                      }

                      log.info(`[Auto-Accept] Successfully sent Enter to ${tailSession}`);
                    } catch (error) {
                      log.error(`[Auto-Accept] Failed to send Enter to ${tailSession}:`, error);
                    }
                  }, autoAcceptDelay);

                  // Track the timer so it can be cancelled on stop
                  autoAcceptTimers.set(tailSession, timerId);
                }
              } else {
                const remainingTime = Math.ceil(autoAcceptDebounceMinutes - timeSinceLastAccept);
                log.debug(`[Auto-Accept] Debouncing - ${remainingTime} minutes remaining for session ${tailSession}`);

                // Add cooldown info to the prompt response
                if (interactivePrompt) {
                  interactivePrompt.autoAcceptCooldown = {
                    active: true,
                    remainingMinutes: remainingTime,
                    totalMinutes: autoAcceptDebounceMinutes
                  };
                }
              }
            }
          }
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            content: stdout,
            contextPercent: contextPercent,
            interactivePrompt: interactivePrompt,
            isBusy: isBusy,
            hasCompactPhrase: hasCompactPhrase
          }));
        } catch (error) {
          // Check if the error is because the session doesn't exist
          const sessionNotFound = error.message && (
            error.message.includes('no server running') ||
            error.message.includes('session not found') ||
            error.message.includes('no sessions') ||
            error.message.includes("can't find session")
          );
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            content: '', 
            contextPercent: null,
            sessionNotFound: sessionNotFound,
            error: sessionNotFound ? 'Session not running' : error.message
          }));
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

      case '/api/reset-cooldown':
        if (method === 'POST') {
          const data = JSON.parse(body);
          const session = data.session || 'claude';

          // Reset the auto-accept cooldown for this session
          if (!autoAcceptState.sessions[session]) {
            autoAcceptState.sessions[session] = {};
          }
          autoAcceptState.sessions[session].lastAutoAcceptTime = null;

          log.info(`[Auto-Accept] Cooldown timer reset for session ${session} via manual reset`);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Cooldown timer reset' }));
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
        // Get running tmux sessions
        const tmuxSessions = await execCommand('tmux list-sessions -F "#{session_name}" 2>/dev/null || echo ""');
        const runningSessionNames = tmuxSessions.trim().split('\n').filter(s => s);
        
        // Also get all sessions with config files
        const configFiles = await fs.readdir(__dirname);
        const configSessionNames = configFiles
          .filter(f => f.startsWith('loop-config-') && f.endsWith('.json'))
          .map(f => f.replace('loop-config-', '').replace('.json', ''));
        
        // Combine both lists (unique values only)
        const allSessionNames = [...new Set([...runningSessionNames, ...configSessionNames])];
        
        // Sort sessions numerically
        allSessionNames.sort((a, b) => {
          const getNum = (str) => {
            const match = str.match(/(\d+)$/);
            return match ? parseInt(match[1]) : Infinity;
          };
          return getNum(a) - getNum(b);
        });
        
        // Load custom names and check if running
        const sessionsWithNames = await Promise.all(allSessionNames.map(async (sessionName) => {
          const config = await getSessionConfig(sessionName, { loopConfig });
          const customName = config.customName || null;
          const isRunning = runningSessionNames.includes(sessionName);
          return {
            id: sessionName,
            name: customName || sessionName,
            hasCustomName: !!customName,
            isRunning: isRunning
          };
        }));
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          sessions: allSessionNames,  // All sessions (running + configs)
          sessionsWithNames          // Enhanced format with running status
        }));
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
        
      case '/api/tmux-pane-cwd':
        const cwdSession = parsedUrl.query.session || 'claude-chat';
        try {
          let conversationPath = null;
          
          // First check if session has a saved conversation ID in config
          const sessionConfig = await getSessionConfig(cwdSession, { loopConfig });
          const savedConversationId = sessionConfig.conversationId || null;
          
          if (savedConversationId) {
            // Look for this specific conversation
            const projectsDir = path.join(HOME_DIR, '.claude', 'projects');
            const projectPaths = [
              path.join(projectsDir, '-home-michael-InfiniQuest-tmp-claudeLoop-dashboard'),
              path.join(projectsDir, '-home-michael-InfiniQuest'),
              path.join(projectsDir, '-home-michael-ai-dev-review'),
              path.join(projectsDir, '-home-michael-Test')
            ];
            
            for (const projectPath of projectPaths) {
              try {
                const filePath = path.join(projectPath, `${savedConversationId}.jsonl`);
                await fs.access(filePath);
                conversationPath = filePath;
                break;
              } catch (e) {
                // File doesn't exist in this directory, try next
              }
            }
          }
          
          if (!conversationPath) {
            // Fall back to finding most recent conversation
            const projectsDir = path.join(HOME_DIR, '.claude', 'projects');
            const projectPaths = [
              path.join(projectsDir, '-home-michael-InfiniQuest-tmp-claudeLoop-dashboard'),
              path.join(projectsDir, '-home-michael-InfiniQuest')
            ];
            
            let mostRecentTime = 0;
            
            for (const projectPath of projectPaths) {
              try {
                const files = await fs.readdir(projectPath);
                const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
                
                for (const file of jsonlFiles) {
                  const filePath = path.join(projectPath, file);
                  const stats = await fs.stat(filePath);
                  if (stats.mtimeMs > mostRecentTime) {
                    mostRecentTime = stats.mtimeMs;
                    conversationPath = filePath;
                  }
                }
              } catch (e) {
                // Directory doesn't exist, skip
              }
            }
          }
          
          if (!conversationPath) {
            throw new Error('No conversation file found');
          }
          
          // Read first few lines to find the system message with working directory
          const content = await fs.readFile(conversationPath, 'utf8');
          const lines = content.split('\n').slice(0, 10); // Check first 10 lines
          
          let cwd = null;
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              // Look for system message with working directory info
              if (msg.role === 'system' || (msg.message && msg.message.role === 'system')) {
                const messageContent = msg.content || msg.message?.content || '';
                // Look for "Working directory: /path/to/dir" pattern
                const cwdMatch = messageContent.match(/Working directory:\s*([^\n]+)/);
                if (cwdMatch) {
                  cwd = cwdMatch[1].trim();
                  break;
                }
              }
            } catch (e) {
              // Skip invalid JSON lines
            }
          }
          
          if (!cwd) {
            throw new Error('Could not find working directory in conversation');
          }
          
          res.writeHead(200, { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*' 
          });
          res.end(JSON.stringify({ cwd, session: cwdSession }));
        } catch (error) {
          log.error('Failed to get initial CWD from conversation:', error);
          res.writeHead(500, { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*' 
          });
          res.end(JSON.stringify({ error: 'Could not detect session working directory' }));
        }
        break;
        
      case '/api/conversation/auto-associate':
        if (method === 'POST') {
          const data = JSON.parse(body);
          const { session } = data;
          
          try {
            log.debug(`[Auto-Associate] Starting for session: ${session}`);
            
            // Strategy 1: Check config file first (single source of truth)
            const sessionConfig = await getSessionConfig(session, { loopConfig });
            if (sessionConfig.conversationId) {
              const convId = sessionConfig.conversationId;
              log.debug(`[Auto-Associate] Found in config: ${convId}`);
              
              // Verify the conversation file exists
              const projectsDir = path.join(HOME_DIR, '.claude', 'projects');
              const possiblePaths = [
                path.join(projectsDir, '-home-michael-InfiniQuest', `${convId}.jsonl`),
                path.join(projectsDir, '-home-michael-InfiniQuest-tmp-claudeLoop', `${convId}.jsonl`),
                path.join(projectsDir, '-home-michael-InfiniQuest-tmp-claudeLoop-dashboard', `${convId}.jsonl`),
                path.join(projectsDir, '-home-michael-Test', `${convId}.jsonl`),
                path.join(projectsDir, '-home-michael', `${convId}.jsonl`)
              ];
              
              for (const convPath of possiblePaths) {
                try {
                  await fs.access(convPath);
                  log.debug(`[Auto-Associate] Verified conversation exists at: ${convPath}`);
                  
                  // Return success
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({
                    success: true,
                    conversationId: convId,
                    source: 'config'
                  }));
                  return;
                } catch (e) {
                  // File doesn't exist, continue checking
                }
              }
              
              log.debug(`[Auto-Associate] Conversation ${convId} from config not found in any project`);
            }
            
            // Strategy 2: Get recent text from tmux and search for it
            const tmuxCmd = `tmux capture-pane -t "${session}" -p -S -500 | tail -100`;
            const recentText = await execCommand(tmuxCmd);
            
            if (!recentText || recentText.length < 20) {
              throw new Error('Not enough text in tmux to match');
            }
            
            // Extract multiple search snippets for better matching
            const lines = recentText.split('\n').filter(line => 
              line.trim() && 
              !line.includes('╭─') && 
              !line.includes('╰─') &&
              !line.includes('│ >') &&
              line.length > 10
            );
            
            const searchSnippets = [
              lines.slice(0, 2).join(' ').substring(0, 100),
              lines.slice(-2).join(' ').substring(0, 100),
              lines.find(l => l.includes('●')) ? lines.find(l => l.includes('●')).substring(0, 100) : null
            ].filter(Boolean);
            
            log.debug(`[Auto-Associate] Searching with ${searchSnippets.length} snippets`);
            
            // Search for conversations containing this text
            const projectsDir = path.join(HOME_DIR, '.claude', 'projects');
            const projectPaths = [
              path.join(projectsDir, '-home-michael-InfiniQuest-tmp-claudeLoop-dashboard'),
              path.join(projectsDir, '-home-michael-InfiniQuest-tmp-claudeLoop'),
              path.join(projectsDir, '-home-michael-InfiniQuest'),
              path.join(projectsDir, '-home-michael-ai-dev-review'),
              path.join(projectsDir, '-home-michael-Test'),
              path.join(projectsDir, '-home-michael')
            ];
            
            let foundConversationId = null;
            let foundWorkingDir = null;
            let bestMatch = { score: 0, conversationId: null, path: null };
            
            for (const projectPath of projectPaths) {
              try {
                const files = await fs.readdir(projectPath);
                const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
                
                log.debug(`[Auto-Associate] Checking ${jsonlFiles.length} conversations in ${path.basename(projectPath)}`);
                
                for (const file of jsonlFiles) {
                  const filePath = path.join(projectPath, file);
                  
                  // Read only the last 50 lines of the file for efficiency
                  const tailCmd = `tail -50 "${filePath}"`;
                  const lastLines = await execCommand(tailCmd);
                  
                  if (!lastLines) continue;
                  
                  // Check each snippet for matches
                  let matchScore = 0;
                  for (const snippet of searchSnippets) {
                    if (lastLines.includes(snippet)) {
                      matchScore += snippet.length; // Longer matches are better
                    }
                  }
                  
                  if (matchScore > bestMatch.score) {
                    bestMatch = {
                      score: matchScore,
                      conversationId: file.replace('.jsonl', ''),
                      path: filePath
                    };
                    log.debug(`[Auto-Associate] Better match found: ${file} (score: ${matchScore}`);
                  }
                }
              } catch (e) {
                log.debug(`[Auto-Associate] Error reading ${projectPath}: ${e.message}`);
                // Skip this project directory
              }
            }
            
            // Check if we found a good match
            if (bestMatch.conversationId && bestMatch.score > 0) {
              foundConversationId = bestMatch.conversationId;
              log.info(`[Auto-Associate] Best match: ${foundConversationId} with score ${bestMatch.score}`);
              
              // Try to get working directory from the matched conversation
              try {
                const headCmd = `head -10 "${bestMatch.path}"`;
                const firstLines = await execCommand(headCmd);
                const lines = firstLines.split('\n');
                
                for (const line of lines) {
                  if (!line.trim()) continue;
                  try {
                    const msg = JSON.parse(line);
                    const content = msg.content || msg.message?.content || '';
                    const cwdMatch = content.match(/Working directory:\s*([^\n]+)/);
                    if (cwdMatch) {
                      foundWorkingDir = cwdMatch[1].trim();
                      log.debug(`[Auto-Associate] Found working directory: ${foundWorkingDir}`);
                      break;
                    }
                  } catch (e) {
                    // Skip invalid JSON
                  }
                }
              } catch (e) {
                log.debug(`[Auto-Associate] Could not extract working directory: ${e.message}`);
              }
            }
            
            if (!foundConversationId) {
              // Strategy 3: Find the most recent conversation in the most likely project
              log.debug(`[Auto-Associate] No text match found, looking for most recent conversation`);
              
              const workingDir = loopConfig.workingDirectory || process.cwd();
              const projectName = workingDir.replace(/\//g, '-');
              const primaryProjectPath = path.join(projectsDir, projectName);
              
              try {
                const files = await fs.readdir(primaryProjectPath);
                const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
                
                if (jsonlFiles.length > 0) {
                  // Get the most recently modified file
                  let mostRecent = { file: null, mtime: 0 };
                  for (const file of jsonlFiles) {
                    const filePath = path.join(primaryProjectPath, file);
                    const stats = await fs.stat(filePath);
                    if (stats.mtimeMs > mostRecent.mtime) {
                      mostRecent = { file, mtime: stats.mtimeMs };
                    }
                  }
                  
                  if (mostRecent.file) {
                    foundConversationId = mostRecent.file.replace('.jsonl', '');
                    log.info(`[Auto-Associate] Using most recent conversation: ${foundConversationId}`);
                  }
                }
              } catch (e) {
                log.debug(`[Auto-Associate] Could not find recent conversations: ${e.message}`);
              }
            }
            
            if (!foundConversationId) {
              throw new Error('Could not find matching conversation');
            }
            
            // Save the association to config (single source of truth)
            const updatedConfig = await getSessionConfig(session, { loopConfig });
            await saveSessionConfig(session, {
              ...updatedConfig,
              conversationId: foundConversationId,
              workingDirectory: foundWorkingDir || process.cwd()
            });
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
              success: true, 
              conversationId: foundConversationId,
              workingDirectory: foundWorkingDir,
              message: `Auto-associated with conversation ${foundConversationId}`,
              matchScore: bestMatch.score
            }));
          } catch (error) {
            log.error('Auto-associate failed:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
          }
        }
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
                // Try to get the loop config for this session using helper
                const config = await getSessionConfig(session, { loopConfig });
                
                if (config.customName && config.customName.trim()) {
                  // Set the conversation name to the loop's custom name
                  await conversationNamer.setName(convInfo.id, config.customName);
                  log.info(`Auto-named conversation ${convInfo.id} as "${config.customName}"`);
                }
              }
            } catch (err) {
              log.error('Error auto-naming conversation:', err);
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
          
          // Just update the config file (single source of truth)
          const config = await getSessionConfig(session, { loopConfig });
          config.conversationId = conversationId;
          config.workingDirectory = workingDirectory || process.cwd();
          await saveSessionConfig(session, config);
          
          log.info(`Assigned conversation ${conversationId} to ${session}`);
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: `Assigned conversation ${conversationId} to ${session}` }));
        }
        break;
        
      case '/api/conversation/current':
        // Get current conversation for session from config file
        const currentSessionParam = parsedUrl.query.session || 'claude';
        const currentConfig = await getSessionConfig(currentSessionParam, { loopConfig });
        
        if (currentConfig.conversationId) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            conversationId: currentConfig.conversationId,
            workingDirectory: currentConfig.workingDirectory,
            session: currentSessionParam
          }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ conversationId: null, session: currentSessionParam }));
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
            log.error('Error browsing directory:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
          }
        }
        break;
        
      case '/api/conversation/delete':
        if (method === 'POST') {
          const data = JSON.parse(body);
          const { conversationId, filePath } = data;
          
          try {
            // Use the provided filePath or find it
            let actualFilePath = filePath;
            let projectDir;
            
            if (!actualFilePath) {
              // Try to find the file by scanning all project directories
              const projectsDir = path.join(os.homedir(), '.claude', 'projects');
              const projectDirs = await fs.readdir(projectsDir);
              
              for (const dir of projectDirs) {
                const possiblePath = path.join(projectsDir, dir, conversationId + '.jsonl');
                try {
                  await fs.access(possiblePath);
                  actualFilePath = possiblePath;
                  projectDir = dir;
                  break;
                } catch (e) {
                  // File doesn't exist in this directory
                }
              }
              
              if (!actualFilePath) {
                throw new Error('Conversation file not found');
              }
            } else {
              // Extract project dir from filepath
              const pathParts = actualFilePath.split(path.sep);
              const projectsIndex = pathParts.indexOf('projects');
              if (projectsIndex >= 0 && projectsIndex < pathParts.length - 1) {
                projectDir = pathParts[projectsIndex + 1];
              }
            }
            
            // Create trash directory if it doesn't exist
            const trashDir = projectDir 
              ? path.join(os.homedir(), '.claude', 'projects', projectDir, '.trash')
              : path.join(os.homedir(), '.claude', '.trash');
            await fs.mkdir(trashDir, { recursive: true });
            
            // Move file to trash
            const trashPath = path.join(trashDir, conversationId + '.jsonl');
            await fs.rename(actualFilePath, trashPath);
            
            log.info(`Moved conversation ${conversationId} to trash`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } catch (error) {
            log.error('Error deleting conversation:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
          }
        }
        break;
        
      case '/api/conversation/resume':
        if (method === 'POST') {
          const data = JSON.parse(body);
          const { conversationId, session, cwd } = data;
          
          try {
            // Validate session is provided
            if (!session) {
              throw new Error('No session specified for resume');
            }
            
            // Determine working directory
            let workingDir = cwd || process.env.HOME || process.cwd();
            
            // If cwd is 'unknown' or not provided, try to get from conversation file
            if (!cwd || cwd === 'unknown') {
              try {
                const projectsDir = path.join(os.homedir(), '.claude', 'projects');
                const projectDirs = await fs.readdir(projectsDir);
                
                for (const dir of projectDirs) {
                  const possiblePath = path.join(projectsDir, dir, conversationId + '.jsonl');
                  try {
                    await fs.access(possiblePath);
                    // Extract working directory from project dir name
                    workingDir = dir.replace(/-/g, '/');
                    if (!workingDir.startsWith('/')) {
                      workingDir = '/' + workingDir;
                    }
                    break;
                  } catch (e) {
                    // File doesn't exist in this directory
                  }
                }
              } catch (e) {
                log.warn('Could not determine working directory from conversation file');
              }
            }
            
            // Use tmux utils to restart Claude with this specific conversation
            const result = await tmuxUtils.restartClaude(session, workingDir, conversationId);
            
            // Trigger auto-setup to catch the fork
            if (result.resumed) {
              // Update session association in config
              const resumeConfig = await getSessionConfig(session, { loopConfig });
              await saveSessionConfig(session, {
                ...resumeConfig,
                conversationId: conversationId,
                workingDirectory: workingDir
              });
              
              // Then monitor for the fork
              conversationAutoSetup.monitorAndSetup(session, {
                workingDir,
                customName: `Resumed from ${conversationId.slice(0, 8)}`,
                isResume: true,
                originalConversationId: conversationId
              }).then(setupResult => {
                if (setupResult.success) {
                  log.info(`[API] Resume fork detected for ${session}: ${setupResult.conversationId} (forked from ${conversationId}`);
                } else {
                  log.warn(`[API] Resume fork detection failed for ${session}: ${setupResult.message}`);
                }
              }).catch(err => {
                log.error(`[API] Resume fork detection error for ${session}:`, err);
              });
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
              success: true, 
              ...result,
              workingDir,
              message: `Resuming conversation ${conversationId} in session ${session}`
            }));
          } catch (error) {
            log.error('Error resuming conversation:', error);
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
          
          // Update the cache with the new name
          const os = require('os');
          const cachePath = path.join(os.homedir(), '.claude', 'conversation-tree-cache.json');
          try {
            const cacheData = await fs.readFile(cachePath, 'utf8');
            const cache = JSON.parse(cacheData);
            if (cache.conversations && cache.conversations[conversationId]) {
              cache.conversations[conversationId].customName = name;
              await fs.writeFile(cachePath, JSON.stringify(cache, null, 2));
              log.debug(`Updated cache with new name for ${conversationId}: ${name}`);
            }
          } catch (e) {
            // Cache might not exist or be invalid, that's ok
            log.debug('Could not update cache with new name:', e.message);
          }
          
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
        // Support both GET and POST for scanning
        if (method === 'GET' || method === 'POST') {
          const ConversationTreeScanner = require('./conversation-tree-scanner');
          const treeScanner = new ConversationTreeScanner();
          const full = parsedUrl.query.full === 'true';
          const cacheOnly = parsedUrl.query.cacheOnly === 'true';
          
          let result;
          if (cacheOnly) {
            // Just load from cache without scanning
            const cache = await treeScanner.getCachedTree();
            result = {
              updatedCount: 0,
              deletedCount: 0,
              totalCount: Object.keys(cache.conversations || {}).length,
              cache: cache,
              fromCache: true
            };
          } else {
            result = full 
              ? await treeScanner.fullScan()
              : await treeScanner.incrementalScan();
          }
            
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            updatedCount: result.updatedCount,
            deletedCount: result.deletedCount,
            totalCount: result.totalCount,
            cache: result.cache,  // Include the full cache for the tree
            fromCache: result.fromCache || false
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
        
      case '/api/pause-status':
        // Return the pause file contents if it exists
        try {
          if (await fs.access(CONFIG.pauseFile).then(() => true).catch(() => false)) {
            const pauseData = await fs.readFile(CONFIG.pauseFile, 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(pauseData);
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ loops: {} }));
          }
        } catch (error) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ loops: {} }));
        }
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
                  log.error('Error clearing intervals:', e);
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
                
                log.info('Stopped all loops');
              } catch (e) {
                log.error('Error in stop-all-loops:', e);
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
                      log.info(`Killed tmux session: ${session}`);
                    } catch (e) {
                      log.error(`Failed to kill session ${session}:`, e.message);
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
                  log.error('Error clearing intervals:', e);
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
                
                log.info('Stopped all claude sessions and loops');
              } catch (e) {
                log.error('Error in stop-all-sessions:', e);
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
          
          // Custom messages from the user should always be sent as-is
          // Don't replace with conditional messages - those are for automatic loop messages
          // Pass true for isManualSend to disable retry Enter
          await sendCustomMessage(message, session, true);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        }
        break;
        
      case '/api/conditional-message':
        if (method === 'GET') {
          const session = parsedUrl.query.session || 'claude';
          const conditionalMsg = await getActiveConditionalMessage(session);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(conditionalMsg || { type: 'none', message: null }));
        }
        break;
        
      case '/api/tmux-command':
        if (method === 'POST') {
          const data = JSON.parse(body);
          const result = await tmuxUtils.sendCommand(data.command, data.session);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        }
        break;
        
      case '/api/tmux-send-key':
        if (method === 'POST') {
          const data = JSON.parse(body);
          const { session, key } = data;
          try {
            const result = await tmuxUtils.sendKey(key, session);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, ...result }));
          } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: error.message }));
          }
        }
        break;

      case '/api/clear-history':
        if (method === 'POST') {
          const data = JSON.parse(body);
          const { session } = data;
          try {
            const result = await tmuxUtils.clearHistory(session);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, ...result }));
          } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: error.message }));
          }
        }
        break;

      case '/api/claude/start':
        if (method === 'POST') {
          const data = JSON.parse(body);
          const session = data.session || 'claude';
          const config = await getSessionConfig(session, { loopConfig });
          const workingDir = config.workingDirectory || 
                            data.workingDirectory ||
                            process.env.HOME || 
                            process.cwd();
          const result = await tmuxUtils.startClaude(session, workingDir);
          
          // Trigger auto-setup in background
          if (result.initialized) {
            conversationAutoSetup.monitorAndSetup(session, {
              workingDir,
              customName: config.customName || session,
              isResume: false
            }).then(setupResult => {
              if (setupResult.success) {
                log.info(`[API] Auto-setup completed for ${session}: ${setupResult.conversationId}`);
              } else {
                log.warn(`[API] Auto-setup failed for ${session}: ${setupResult.message}`);
              }
            }).catch(err => {
              log.error(`[API] Auto-setup error for ${session}:`, err);
            });
          }
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        }
        break;
        
      case '/api/claude/stop':
        if (method === 'POST') {
          const data = JSON.parse(body);
          const result = await tmuxUtils.stopClaude(data.session);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        }
        break;

      case '/api/cancel-pending-messages':
        if (method === 'POST') {
          const data = JSON.parse(body);
          const session = data.session || 'claude';

          let cancelledCount = 0;
          if (activeSendProcesses.has(session)) {
            const processes = activeSendProcesses.get(session);
            for (const proc of processes) {
              try {
                proc.kill('SIGTERM');
                cancelledCount++;
              } catch (err) {
                log.warn(`[Panic Stop] Failed to kill process: ${err.message}`);
              }
            }
            activeSendProcesses.delete(session);
          }

          log.info(`[Panic Stop] Cancelled ${cancelledCount} pending message(s) for ${session}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, cancelled: cancelledCount }));
        }
        break;

      case '/api/claude/restart':
        if (method === 'POST') {
          const data = JSON.parse(body);
          const session = data.session || 'claude';
          const config = await getSessionConfig(session, { loopConfig });
          
          // Try to get working directory from multiple sources
          const workingDir = config.workingDirectory || 
                            data.workingDirectory || 
                            process.env.HOME || 
                            process.cwd();
          
          const conversationId = config.conversationId || null;
          
          const result = await tmuxUtils.restartClaude(session, workingDir, conversationId);
          
          // If we resumed, trigger auto-setup to catch the fork
          if (result.resumed) {
            conversationAutoSetup.monitorAndSetup(session, {
              workingDir,
              customName: config.customName || session,
              isResume: true,
              originalConversationId: conversationId
            }).then(setupResult => {
              if (setupResult.success) {
                log.info(`[API] Fork auto-setup completed for ${session}: ${setupResult.conversationId} (forked from ${conversationId})`);
              } else {
                log.warn(`[API] Fork auto-setup failed for ${session}: ${setupResult.message}`);
              }
            }).catch(err => {
              log.error(`[API] Fork auto-setup error for ${session}:`, err);
            });
          }
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        }
        break;
        
      case '/api/claude/compact':
        if (method === 'POST') {
          const data = JSON.parse(body);
          const result = await tmuxUtils.sendCompact(data.session);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        }
        break;
        
      case '/api/send-key':
        if (method === 'POST') {
          const data = JSON.parse(body);
          const result = await tmuxUtils.sendKey(data.key, data.session);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
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
        
      case '/api/tmux/restart':
        if (method === 'POST') {
          const session = parsedUrl.query.session || 'claude-loop1';
          try {
            // Get the session's configuration to find its working directory
            const sessionConfig = await getSessionConfig(session, { loopConfig });
            const workingDir = sessionConfig.workingDirectory || CONFIG.workingDirectory || process.cwd();
            
            // First, kill the existing session if it exists
            try {
              await execAsync(`tmux kill-session -t "${session}" 2>/dev/null`);
              log.info(`Killed existing tmux session: ${session}`);
            } catch (e) {
              // Session might not exist, that's okay
              log.debug(`Session ${session} didn't exist, creating new one`);
            }
            
            // Create a new session with the same name
            await execAsync(`tmux new-session -d -s "${session}" -c "${workingDir}"`);
            log.debug(`Created new tmux session: ${session} in ${workingDir}`);
            
            // Start Claude in the new session with the correct project directory
            const claudeCmd = `claude --project "${workingDir}"`;
            await execAsync(`tmux send-keys -t "${session}" "${claudeCmd}" Enter`);
            log.info(`Started Claude in session: ${session} with project: ${workingDir}`);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: `Restarted tmux session ${session}` }));
          } catch (error) {
            log.error('Failed to restart tmux session:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: error.message }));
          }
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
          const workingDir = data.workingDir || process.env.HOME || process.cwd();
          // Create new tmux session and start claude with resume option in the specified directory
          await execAsync('tmux new-session -d -s ' + session + ' -c "' + workingDir + '" \'claude --resume\'');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        }
        break;

      case '/api/todos':
        if (method === 'GET') {
          await loadTodos();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(todos));
        } else if (method === 'POST') {
          const data = JSON.parse(body);
          const newTodo = {
            id: generateTodoId(),
            text: data.text || '',
            status: 'pending', // pending, claude_done, user_approved
            claude_session: data.claude_session || null,
            created_at: new Date().toISOString(),
            claude_completed_at: null,
            user_approved_at: null,
            priority: data.priority || 'normal', // low, normal, high
            category: data.category || 'other', // bug, feature, research, other
            notes: [],
            project: data.project || null,
            parentId: data.parentId || null
          };
          await loadTodos();
          todos.push(newTodo);
          await saveTodos();
          
          // Log the change
          await historyManager.logChange({
            action: 'ADD',
            todoId: newTodo.id,
            newValue: newTodo,
            sessionId: data.claude_session
          });
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(newTodo));
        }
        break;

      case '/api/todos/update':
        if (method === 'PUT') {
          const data = JSON.parse(body);
          await loadTodos();
          const todoIndex = todos.findIndex(t => t.id === data.id);
          if (todoIndex !== -1) {
            const oldTodo = { ...todos[todoIndex] };
            
            // Update specific fields based on what's provided
            if (data.status) {
              todos[todoIndex].status = data.status;
              if (data.status === 'claude_done' && !todos[todoIndex].claude_completed_at) {
                todos[todoIndex].claude_completed_at = new Date().toISOString();
              } else if (data.status === 'user_approved' && !todos[todoIndex].user_approved_at) {
                todos[todoIndex].user_approved_at = new Date().toISOString();
              }
            }
            if (data.text !== undefined) todos[todoIndex].text = data.text;
            if (data.priority !== undefined) todos[todoIndex].priority = data.priority;
            if (data.category !== undefined) todos[todoIndex].category = data.category;
            if (data.note) {
              if (!todos[todoIndex].notes) todos[todoIndex].notes = [];
              todos[todoIndex].notes.push({
                text: data.note,
                timestamp: new Date().toISOString(),
                session: data.claude_session || null
              });
            }
            await saveTodos();
            
            // Log changes for each field that changed
            for (const field of Object.keys(data)) {
              if (field !== 'id' && field !== 'claude_session' && oldTodo[field] !== todos[todoIndex][field]) {
                await historyManager.logChange({
                  action: 'UPDATE',
                  todoId: data.id,
                  field: field,
                  oldValue: oldTodo[field],
                  newValue: todos[todoIndex][field],
                  sessionId: data.claude_session
                });
              }
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(todos[todoIndex]));
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Todo not found' }));
          }
        }
        break;

      case '/api/todos/delete':
        if (method === 'DELETE') {
          const data = JSON.parse(body);
          await loadTodos();
          const todoToDelete = todos.find(t => t.id === data.id);
          
          if (todoToDelete) {
            // Log the deletion
            await historyManager.logChange({
              action: 'DELETE',
              todoId: data.id,
              oldValue: todoToDelete,
              sessionId: data.claude_session
            });
            
            // Soft delete: mark as deleted with timestamp instead of removing
            todoToDelete.status = 'deleted';
            todoToDelete.deleted_at = new Date().toISOString();
            todoToDelete.deleted_by = data.claude_session || 'unknown';
            
            await saveTodos();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Todo not found' }));
          }
        }
        break;

      case '/api/todos/deleted':
        if (method === 'GET') {
          await loadTodos();
          // Get deleted todos from the last 7 days
          const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
          const deletedTodos = todos.filter(t => 
            t.status === 'deleted' && 
            t.deleted_at && 
            t.deleted_at > sevenDaysAgo
          ).sort((a, b) => new Date(b.deleted_at) - new Date(a.deleted_at));
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(deletedTodos));
        }
        break;
        
      case '/api/todos/restore':
        if (method === 'POST') {
          const data = JSON.parse(body);
          await loadTodos();
          const todoToRestore = todos.find(t => t.id === data.id && t.status === 'deleted');
          
          if (todoToRestore) {
            // Restore the todo
            todoToRestore.status = data.previousStatus || 'pending';
            delete todoToRestore.deleted_at;
            delete todoToRestore.deleted_by;
            todoToRestore.restored_at = new Date().toISOString();
            todoToRestore.restored_by = data.claude_session || 'unknown';
            
            await saveTodos();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, todo: todoToRestore }));
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Deleted todo not found' }));
          }
        }
        break;
        
      case '/api/todos/cleanup-deleted':
        if (method === 'POST') {
          await loadTodos();
          // Remove todos deleted more than 7 days ago
          const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
          const beforeCount = todos.length;
          todos = todos.filter(t => 
            t.status !== 'deleted' || 
            !t.deleted_at || 
            t.deleted_at > sevenDaysAgo
          );
          const removedCount = beforeCount - todos.length;
          
          await saveTodos();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, removed: removedCount }));
        }
        break;

      case '/api/todos/reorder':
        if (method === 'POST') {
          const data = JSON.parse(body);
          
          // Updated to handle both order and parentId
          if (data.todos && Array.isArray(data.todos)) {
            await loadTodos();
            // Update each todo with new order and parentId
            data.todos.forEach(update => {
              const todo = todos.find(t => t.id === update.id);
              if (todo) {
                if (update.order !== undefined) todo.order = update.order;
                if (update.parentId !== undefined) todo.parentId = update.parentId;
              }
            });
            // Sort by order
            todos.sort((a, b) => (a.order || 0) - (b.order || 0));
            await saveTodos();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } else if (data.todoIds && Array.isArray(data.todoIds)) {
            // Legacy support for simple reordering
            await loadTodos();
            const reorderedTodos = [];
            const todoMap = new Map(todos.map(t => [t.id, t]));
            for (const id of data.todoIds) {
              if (todoMap.has(id)) {
                reorderedTodos.push(todoMap.get(id));
              }
            }
            for (const todo of todos) {
              if (!data.todoIds.includes(todo.id)) {
                reorderedTodos.push(todo);
              }
            }
            todos = reorderedTodos;
            await saveTodos();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid data format' }));
          }
        }
        break;
        
      case '/api/todos/bulk-update':
        if (method === 'POST') {
          const data = JSON.parse(body);
          if (data.todos && Array.isArray(data.todos)) {
            await loadTodos(); // Load existing todos first
            
            // Update existing todos or add new ones
            for (const updateTodo of data.todos) {
              const existingIndex = todos.findIndex(t => t.id === updateTodo.id);
              if (existingIndex !== -1) {
                // Update existing todo
                Object.assign(todos[existingIndex], updateTodo);
                await historyManager.logChange(updateTodo.id, 'UPDATE', todos[existingIndex]);
              } else {
                // Add new todo if it doesn't exist
                todos.push(updateTodo);
                await historyManager.logChange(updateTodo.id, 'ADD', updateTodo);
              }
            }
            
            await saveTodos();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, count: todos.length }));
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid todos array' }));
          }
        }
        break;



      case '/api/todos/bulk-add':
        if (method === 'POST') {
          const data = JSON.parse(body);
          
          // Require project to be specified for bulk operations
          if (!data.project) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
              error: 'Project is required for bulk-add operations',
              message: 'Please specify a project to prevent mixing todos'
            }));
            break;
          }
          
          if (data.todos && Array.isArray(data.todos)) {
            await loadTodos();
            let added = 0;
            const project = data.project;
            
            for (const newTodo of data.todos) {
              // Ensure todo has required fields
              if (!newTodo.id) {
                newTodo.id = generateTodoId();
              }
              if (!newTodo.created_at) {
                newTodo.created_at = new Date().toISOString();
              }
              if (!newTodo.status) {
                newTodo.status = 'pending';
              }
              // Ensure todo gets the project
              if (!newTodo.project) {
                newTodo.project = project;
              }
              
              // Check for duplicates by ID
              const exists = todos.some(t => t.id === newTodo.id);
              if (!exists) {
                todos.push(newTodo);
                await historyManager.logChange(newTodo.id, 'ADD', newTodo);
                added++;
              }
            }
            
            await saveTodos();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, added: added, total: todos.length }));
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid bulk add data' }));
          }
        }
        break;
        
      case '/api/todos/checkpoints':
        if (method === 'GET') {
          const checkpoints = await historyManager.listCheckpoints();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(checkpoints));
        } else if (method === 'POST') {
          const data = body ? JSON.parse(body) : {};
          const checkpoint = await historyManager.createCheckpoint(data.name);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(checkpoint));
        }
        break;

      case '/api/todos/restore-checkpoint':
        if (method === 'POST') {
          const data = JSON.parse(body);
          if (data.filename) {
            const restoredTodos = await historyManager.restoreCheckpoint(data.filename);
            todos = restoredTodos;
            await saveTodos();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, count: todos.length }));
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Filename required' }));
          }
        }
        break;
        
      case '/api/todos/pending':
        if (method === 'GET') {
          // Parse query parameters
          const project = parsedUrl.query.project;
          const priority = parsedUrl.query.priority;
          const format = parsedUrl.query.format;
          
          // Filter for pending todos only
          let pendingTodos = todos.filter(t => t.status === 'pending');
          
          // Apply additional filters if provided
          if (project) {
            pendingTodos = pendingTodos.filter(t => t.project === project);
          }
          if (priority) {
            pendingTodos = pendingTodos.filter(t => t.priority === priority);
          }
          
          // Return compact format if requested
          if (format === 'compact') {
            const compactTodos = pendingTodos.map(t => ({
              id: t.id,
              text: t.text,
              priority: t.priority || 'normal',
              project: t.project || 'unassigned',
              parentId: t.parentId
            }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(compactTodos));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(pendingTodos));
          }
        }
        break;
        
      case '/api/todos/search':
        if (method === 'GET') {
          const searchQuery = parsedUrl.query.q || '';
          const status = parsedUrl.query.status;
          const project = parsedUrl.query.project;
          const category = parsedUrl.query.category;
          const priority = parsedUrl.query.priority;
          const format = parsedUrl.query.format;

          let results = todos;

          // Text search in todo text and notes
          if (searchQuery) {
            const query = searchQuery.toLowerCase();
            results = results.filter(t =>
              t.text.toLowerCase().includes(query) ||
              (t.notes && t.notes.some(note => note.toLowerCase().includes(query)))
            );
          }

          // Apply filters
          if (status) results = results.filter(t => t.status === status);
          if (project) results = results.filter(t => t.project === project);
          if (category) results = results.filter(t => t.category === category);
          if (priority) results = results.filter(t => t.priority === priority);

          // Return compact format if requested
          if (format === 'compact') {
            const compactResults = results.map(t => ({
              id: t.id,
              text: t.text,
              status: t.status,
              priority: t.priority || 'normal',
              project: t.project || 'unassigned'
            }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(compactResults));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(results));
          }
        }
        break;

      case '/api/webhook/status':
        if (method === 'POST') {
          // Parse JSON with error handling
          let statusData;
          try {
            statusData = JSON.parse(body);
          } catch (error) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON in request body' }));
            return;
          }

          // Validate required fields
          const validStatuses = ['done', 'idle', 'waiting', 'stuck', 'needs-input', 'auto-compact'];
          if (!statusData.status || !validStatuses.includes(statusData.status)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: 'Invalid status. Must be one of: ' + validStatuses.join(', ')
            }));
            return;
          }

          if (!statusData.session) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Session name is required' }));
            return;
          }

          // Get session config to access review settings
          const config = await getSessionConfig(statusData.session, { loopConfig });

          // Log the status update
          log.info(`[Webhook] Status update from ${statusData.session}: ${statusData.status}`);
          if (statusData.context) {
            log.debug(`[Webhook] Context: ${JSON.stringify(statusData.context)}`);
          }

          // Initialize session webhook state if needed
          if (!webhookState[statusData.session]) {
            webhookState[statusData.session] = {
              reviewCount: 0,
              lastStatus: null,
              lastTaskHash: null
            };
          }

          const sessionState = webhookState[statusData.session];

          // Create a hash of the current task context to detect task changes
          const taskHash = statusData.context?.task ?
            JSON.stringify(statusData.context.task) : null;

          // Reset review count if task changed
          if (taskHash && taskHash !== sessionState.lastTaskHash) {
            sessionState.reviewCount = 0;
            sessionState.lastTaskHash = taskHash;
            log.debug(`[Webhook] New task detected for ${statusData.session}, reset review count`);
          }

          // Handle different status types
          let response = { received: true };

          switch (statusData.status) {
            case 'done':
              const reviewsRequired = config.reviewSettings?.reviewsBeforeNextTask || 0;

              // Only track review count if reviews are actually enabled
              if (reviewsRequired > 0) {
                sessionState.reviewCount++;
                log.info(`[Webhook] Review count for ${statusData.session}: ${sessionState.reviewCount}/${reviewsRequired}`);

                if (sessionState.reviewCount < reviewsRequired) {
                  // Need more reviews - send review request message
                  const reviewMessage = config.reviewSettings?.reviewMessage ||
                    "Please review the work you just completed. Are there any improvements needed?";

                  // Schedule the review message to be sent
                  response.action = 'review';
                  response.message = reviewMessage;
                  response.reviewsRemaining = reviewsRequired - sessionState.reviewCount;

                  log.info(`[Webhook] Scheduling review message for ${statusData.session} (${response.reviewsRemaining} reviews remaining)`);

                  // Send the review message after a short delay
                  setTimeout(async () => {
                    try {
                      await sendCustomMessage(reviewMessage, statusData.session);
                      log.info(`[Webhook] Sent review message to ${statusData.session}`);
                    } catch (error) {
                      log.error(`[Webhook] Failed to send review message: ${error.message}`);
                    }
                  }, 2000); // 2 second delay
                } else {
                  // Reviews complete - ready for next task
                  sessionState.reviewCount = 0; // Reset for next task
                  response.action = 'next-task';

                  const nextTaskMessage = config.reviewSettings?.nextTaskMessage ||
                    "Work completed and reviewed. Please proceed to the next task.";

                  log.info(`[Webhook] Reviews complete for ${statusData.session}, proceeding to next task`);

                  // Send next task message after a short delay
                  setTimeout(async () => {
                    try {
                      await sendCustomMessage(nextTaskMessage, statusData.session);
                      log.info(`[Webhook] Sent next task message to ${statusData.session}`);
                    } catch (error) {
                      log.error(`[Webhook] Failed to send next task message: ${error.message}`);
                    }
                  }, 2000); // 2 second delay
                }
              } else {
                // Reviews disabled - just acknowledge completion
                response.action = 'next-task';
                log.info(`[Webhook] Work complete for ${statusData.session} (reviews disabled)`);
              }
              break;

            case 'idle':
            case 'waiting':
              // Just acknowledge, idle message system will handle this
              response.action = 'acknowledged';
              log.debug(`[Webhook] Status ${statusData.status} acknowledged for ${statusData.session}`);
              break;

            case 'auto-compact':
              // Trigger compact command with debounce check
              response.action = 'compact';
              log.info(`[Webhook] Auto-compact requested for ${statusData.session}`);

              // Use the existing sendCompactIfNeeded which has built-in debounce
              setTimeout(async () => {
                try {
                  await sendCompactIfNeeded(statusData.session, 'webhook-auto-compact');
                  log.info(`[Webhook] Triggered compact for ${statusData.session}`);
                } catch (error) {
                  log.error(`[Webhook] Failed to trigger compact: ${error.message}`);
                }
              }, 1000); // 1 second delay
              break;

            case 'stuck':
            case 'needs-input':
              // Send notification or escalation message
              response.action = 'needs-attention';
              log.warn(`[Webhook] Session ${statusData.session} needs attention: ${statusData.status}`);

              if (statusData.context?.question) {
                log.warn(`[Webhook] Question: ${statusData.context.question}`);
              }
              break;
          }

          // Update last status
          sessionState.lastStatus = statusData.status;
          sessionState.lastStatusTime = Date.now();

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
        } else {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
        }
        break;

      default:
        // Check for dynamic routes
        if (pathname.match(/^\/api\/sessions\/([^\/]+)\/info$/) && method === 'GET') {
          // Get session info for deletion preview
          const sessionMatch = pathname.match(/^\/api\/sessions\/([^\/]+)\/info$/);
          const session = sessionMatch[1];
          
          try {
            // Get config file size
            const configPath = path.join(__dirname, `loop-config-${session}.json`);
            let configSize = 0;
            try {
              const stats = await fs.stat(configPath);
              configSize = stats.size;
            } catch (e) {
              // Config file might not exist
            }
            
            // Get conversation files info
            let conversationCount = 0;
            let conversationSize = 0;
            
            // Check various possible conversation directories
            const projectPaths = [
              path.join(HOME_DIR, '.claude', 'projects', '-home-michael-InfiniQuest-tmp-claudeLoop-dashboard'),
              path.join(HOME_DIR, '.claude', 'projects', '-home-michael-InfiniQuest-tmp-claudeLoop'),
              path.join(HOME_DIR, '.claude', 'projects', '-home-michael-InfiniQuest'),
            ];
            
            for (const projectPath of projectPaths) {
              try {
                const files = await fs.readdir(projectPath);
                // Look for files that might belong to this session
                for (const file of files) {
                  if (file.includes(session) && file.endsWith('.jsonl')) {
                    conversationCount++;
                    const filePath = path.join(projectPath, file);
                    const stats = await fs.stat(filePath);
                    conversationSize += stats.size;
                  }
                }
              } catch (e) {
                // Directory might not exist
              }
            }
            
            // Format sizes
            const formatSize = (bytes) => {
              if (bytes < 1024) return `${bytes} B`;
              if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
              return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
            };
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              session,
              configSize: formatSize(configSize),
              conversationCount,
              conversationSize: formatSize(conversationSize)
            }));
          } catch (error) {
            log.error('Failed to get session info:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
          }
        } else if (pathname.match(/^\/api\/sessions\/([^\/]+)\/delete$/) && method === 'DELETE') {
          // Delete session and its files
          const sessionMatch = pathname.match(/^\/api\/sessions\/([^\/]+)\/delete$/);
          const session = sessionMatch[1];
          const data = body ? JSON.parse(body) : {};
          const deleteConversations = data.deleteConversations || false;
          
          let deletedFiles = 0;
          
          try {
            // 1. Kill tmux session if it exists
            try {
              await execAsync(`tmux kill-session -t "${session}" 2>/dev/null`);
              log.info(`Killed tmux session: ${session}`);
            } catch (e) {
              // Session might not be running
              log.info(`Tmux session ${session} was not running`);
            }
            
            // 2. Backup and delete config file
            const configPath = path.join(__dirname, `loop-config-${session}.json`);
            const backupDir = path.join(__dirname, '.deleted');
            
            try {
              // Create backup directory if it doesn't exist
              await fs.mkdir(backupDir, { recursive: true });
              
              // Backup config file with timestamp
              const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
              const backupPath = path.join(backupDir, `loop-config-${session}-${timestamp}.json`);
              await fs.copyFile(configPath, backupPath);
              log.info(`Backed up config to: ${backupPath}`);
              
              // Delete original config
              await fs.unlink(configPath);
              deletedFiles++;
              log.info(`Deleted config: ${configPath}`);
            } catch (e) {
              log.error(`Failed to handle config file: ${e.message}`);
            }
            
            // 3. Optionally delete conversation logs
            if (deleteConversations) {
              const projectPaths = [
                path.join(HOME_DIR, '.claude', 'projects', '-home-michael-InfiniQuest-tmp-claudeLoop-dashboard'),
                path.join(HOME_DIR, '.claude', 'projects', '-home-michael-InfiniQuest-tmp-claudeLoop'),
                path.join(HOME_DIR, '.claude', 'projects', '-home-michael-InfiniQuest'),
              ];
              
              for (const projectPath of projectPaths) {
                try {
                  const files = await fs.readdir(projectPath);
                  for (const file of files) {
                    if (file.includes(session) && file.endsWith('.jsonl')) {
                      const filePath = path.join(projectPath, file);
                      await fs.unlink(filePath);
                      deletedFiles++;
                      log.info(`Deleted conversation: ${filePath}`);
                    }
                  }
                } catch (e) {
                  // Directory might not exist or file might not be deletable
                }
              }
            }
            
            // 4. Clean up old backups (older than 30 days)
            try {
              const backupFiles = await fs.readdir(backupDir);
              const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
              
              for (const file of backupFiles) {
                const filePath = path.join(backupDir, file);
                const stats = await fs.stat(filePath);
                if (stats.mtimeMs < thirtyDaysAgo) {
                  await fs.unlink(filePath);
                  log.info(`Cleaned up old backup: ${file}`);
                }
              }
            } catch (e) {
              // Backup cleanup is not critical
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: true,
              session,
              deletedFiles,
              message: `Session ${session} deleted successfully`
            }));
          } catch (error) {
            log.error('Failed to delete session:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
          }
        } else if (pathname.startsWith('/api/todos/project/') && method === 'GET') {
          const projectId = pathname.split('/').pop();
          const projectTodos = todos.filter(t => t.project === projectId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(projectTodos));
        } else if (pathname.startsWith('/api/todos/claude-native/') && method === 'GET') {
          // Get native todos for a specific conversation
          const conversationId = pathname.split('/').pop();
          let nativeTodos = [];
          
          try {
            // Build the expected filename pattern
            const todoFilePath = path.join(HOME_DIR, '.claude', 'todos', 
              `${conversationId}-agent-${conversationId}.json`);
            
            const todoData = await fs.readFile(todoFilePath, 'utf8');
            nativeTodos = JSON.parse(todoData);
          } catch (error) {
            // File doesn't exist or can't be parsed - that's OK
            nativeTodos = [];
          }
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(nativeTodos));
        } else if (pathname.match(/^\/api\/todos\/claude-native\/[^/]+\/save$/) && method === 'POST') {
          // Save native todos for a specific conversation
          const conversationId = pathname.split('/')[4];

          try {
            // Parse the body that was already collected
            const todos = JSON.parse(body);

            // Build the expected filename pattern
            const todoFilePath = path.join(HOME_DIR, '.claude', 'todos',
              `${conversationId}-agent-${conversationId}.json`);

            // Save to file
            await fs.writeFile(todoFilePath, JSON.stringify(todos, null, 2), 'utf8');

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, count: todos.length }));
          } catch (error) {
            log.error('Failed to save native todos:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
          }
        } else if (pathname.startsWith('/api/todos/history/') && method === 'GET') {
          const todoId = pathname.split('/').pop();
          const history = await historyManager.getTodoHistory(todoId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(history));
        } else if (pathname.startsWith('/api/todos/undo/') && method === 'POST') {
          const todoId = pathname.split('/').pop();
          const result = await historyManager.undoTodo(todoId);
          if (result.success && result.revert) {
            // Apply the revert operation
            await loadTodos();
            const todoIndex = todos.findIndex(t => t.id === todoId);
            
            if (result.revert.action === 'UPDATE' && todoIndex !== -1) {
              todos[todoIndex][result.revert.field] = result.revert.value;
              await saveTodos();
            } else if (result.revert.action === 'DELETE') {
              todos = todos.filter(t => t.id !== todoId);
              await saveTodos();
            } else if (result.revert.action === 'ADD' && result.revert.data) {
              todos.push(result.revert.data);
              await saveTodos();
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } else if (pathname.startsWith('/api/todos/redo/') && method === 'POST') {
          const todoId = pathname.split('/').pop();
          const result = await historyManager.redoTodo(todoId);
          if (result.success && result.apply) {
            // Apply the redo operation
            await loadTodos();
            const todoIndex = todos.findIndex(t => t.id === todoId);
            
            if (result.apply.action === 'UPDATE' && todoIndex !== -1) {
              todos[todoIndex][result.apply.field] = result.apply.value;
              await saveTodos();
            } else if (result.apply.action === 'DELETE') {
              todos = todos.filter(t => t.id !== todoId);
              await saveTodos();
            } else if (result.apply.action === 'ADD' && result.apply.data) {
              todos.push(result.apply.data);
              await saveTodos();
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
    }
  } catch (error) {
    log.error('API error:', error);
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

// Unified content analysis - run all detections in one pass
function analyzeContent(content, session, hints = {}) {
  // Initialize session cache if needed
  if (!analysisState.sessions[session]) {
    analysisState.sessions[session] = {
      cache: {
        prompt: { result: null, expires: 0 },
        activity: { result: null, expires: 0 },
        context: { result: null, expires: 0 }
      },
      lastAnalysisTime: 0,
      lastAnalysis: null,
      lastPromptLogTime: 0
    };
  }
  
  const sessionCache = analysisState.sessions[session].cache;
  const now = Date.now();
  
  // If hints are provided, only run the necessary analysis
  const result = {
    timestamp: now,
    session: session
  };
  
  // Only check for prompts if explicitly hinted
  if (!hints.skipPrompt && hints.checkPrompt) {
    // Check cache first
    if (sessionCache.prompt.expires > now) {
      result.interactivePrompt = sessionCache.prompt.result;
      log.debug(`[Cache] Using cached prompt detection for ${session}`);
    } else {
      result.interactivePrompt = detectInteractivePrompt(content);
      sessionCache.prompt.result = result.interactivePrompt;
      sessionCache.prompt.expires = now + CACHE_TTL.prompt;
    }
  }
  
  // Only check activity if explicitly hinted
  if (!hints.skipActivity && hints.checkActivity) {
    // Check cache first
    if (sessionCache.activity.expires > now) {
      result.isBusy = sessionCache.activity.result;
      log.debug(`[Cache] Using cached activity detection for ${session}`);
    } else {
      // Check only last 20 lines for "esc to interrupt" prompt
      // The status prompt is always at the bottom, no need to scan entire output
      const lines = content.split('\n');
      const last20Lines = lines.slice(-20).join('\n').toLowerCase();
      // Strip ANSI escape codes for reliable matching (Claude Code may add color formatting)
      const cleanLines = last20Lines.replace(/\x1b\[[0-9;]*m/g, '');
      result.isBusy = cleanLines.includes('esc to interrupt');
      sessionCache.activity.result = result.isBusy;
      sessionCache.activity.expires = now + CACHE_TTL.activity;
    }
  }
  
  // Only check context if explicitly hinted
  if (!hints.skipContext && hints.checkContext) {
    // Check cache first
    if (sessionCache.context.expires > now) {
      result.contextPercent = sessionCache.context.result;
      log.debug(`[Cache] Using cached context detection for ${session}`);
    } else {
      let contextPercent = null;
      const inputBoxMatch = content.match(/─{3,}╯([^]*?)$/);
      if (inputBoxMatch) {
        const statusAreaText = inputBoxMatch[1];
        const contextPatterns = [
          /Context\s+left\s+until\s+auto-compact:\s*(\d+)%/i,
          /context\s+low\s*\((\d+)%\s*remaining\)/i,
          /context[\s\S]{0,20}?(\d+)%/i,
          /(\d+)%[\s\S]{0,20}?context/i,
        ];
        
        for (const pattern of contextPatterns) {
          const match = statusAreaText.match(pattern);
          if (match) {
            contextPercent = parseInt(match[1]);
            break;
          }
        }
      }
      result.contextPercent = contextPercent;
      sessionCache.context.result = contextPercent;
      sessionCache.context.expires = now + CACHE_TTL.context;
    }
  }

  return result;
}

// Track last analysis per session with debounce
// Different TTLs for different detection types
const CACHE_TTL = {
  prompt: 5000,      // 5 seconds - needs responsiveness
  activity: 2000,    // 2 seconds - changes frequently
  context: 20000     // 20 seconds - changes slowly
};

const analysisState = {
  sessions: {}
};

function getAnalysis(content, session, hints = {}) {
  // Initialize session state if needed (must match analyzeContent structure!)
  if (!analysisState.sessions[session]) {
    analysisState.sessions[session] = {
      cache: {
        prompt: { result: null, expires: 0 },
        activity: { result: null, expires: 0 },
        context: { result: null, expires: 0 }
      },
      lastAnalysisTime: 0,
      lastAnalysis: null,
      lastPromptLogTime: 0
    };
  }
  
  const state = analysisState.sessions[session];
  const now = Date.now();
  
  // Debounce: only re-analyze if 5+ seconds have passed
  // But if we have specific hints, always analyze those parts
  if (now - state.lastAnalysisTime < 5000 && state.lastAnalysis && !Object.keys(hints).length) {
    return state.lastAnalysis;
  }
  
  // Perform fresh analysis with hints
  const analysis = analyzeContent(content, session, hints);
  
  // Log prompt detection only if new or changed
  if (analysis.interactivePrompt?.detected) {
    const lastPrompt = state.lastAnalysis?.interactivePrompt;
    if (!lastPrompt?.detected || 
        lastPrompt.type !== analysis.interactivePrompt.type ||
        now - state.lastPromptLogTime > 30000) {
      log.debug(`[Interactive Prompt] Detected ${analysis.interactivePrompt.type} prompt for session ${session}`);
      state.lastPromptLogTime = now;
    }
  }
  
  // Update state
  state.lastAnalysisTime = now;
  state.lastAnalysis = analysis;
  
  return analysis;
}

async function scrapeContextFromTmux(session) {
  try {
    // Capture the visible window from tmux (what's currently on screen)
    const { stdout: visibleContent } = await execAsync(`tmux capture-pane -pt "${session}" -e 2>/dev/null || echo ""`);
    
    // Debug mode - log what we capture when looking for context
    if (process.env.DEBUG_CONTEXT_SCRAPING) {
      log.verbose('=== TMUX CAPTURE DEBUG ===');
      log.verbose(visibleContent);
      log.verbose('=== END CAPTURE ===');
    }
    
    // Find the input box boundaries
    // The input box has a top border like: ╭────────────────╮
    // and a bottom border like: ╰────────────────╯
    const inputBoxTopMatch = visibleContent.match(/╭─{3,}╮/);
    const inputBoxBottomMatch = visibleContent.match(/╰─{3,}╯/);
    
    // NOTE: Compact detection has been moved to detectCompactPhrase() function
    // which is called via analyzeContent when keywords are detected.
    // This avoids duplicate detection logic.
    
    // Find the status area (everything after the input box bottom border)
    let statusAreaText = '';
    if (inputBoxBottomMatch) {
      const inputBoxEndIndex = inputBoxBottomMatch.index + inputBoxBottomMatch[0].length;
      statusAreaText = visibleContent.substring(inputBoxEndIndex);
      log.verbose(`[Context Debug] Found input box bottom, status area length: ${statusAreaText.length}`);
    } else {
      // Fallback: if we can't find proper boundaries, skip compact detection
      // but still try to find context percentage in the whole content
      statusAreaText = visibleContent;
      log.verbose(`[Context Debug] No input box bottom found, using full content (${statusAreaText.length} chars)`);
    }
    
    // TEMPORARY DEBUG: Show what we're searching in
    const statusPreview = statusAreaText.substring(0, 300).replace(/\n/g, '\\n').replace(/\r/g, '\\r');
    log.verbose(`[Context Debug] Status area preview: "${statusPreview}..."`);
    
    // Look for a percentage number near the word "context"
    // Common formats:
    // - "Context left until auto-compact: 16%" (new status bar format)
    // - "Context low (34% remaining)"
    // - "Context: 15%"
    // - "15% Context"
    // The [\s\S] matches any character including newlines
    const contextPatterns = [
      // New status bar format - flexible to handle line breaks
      /Context\s+left\s+until[\s\S]*?auto-compact:\s*(\d+)%/i,
      // Direct auto-compact pattern (fallback for split lines)
      /auto-compact:\s*(\d+)%/i,
      // Primary pattern for "Context low (34% remaining)"
      /context\s+low\s*\((\d+)%\s*remaining\)/i,
      // Generic patterns for other formats
      /context[\s\S]{0,20}?(\d+)%/i,
      /(\d+)%[\s\S]{0,20}?context/i,
      // Pattern with parentheses
      /context[^(]*\((\d+)%/i,
    ];
    
    // TEMPORARY DEBUG: Log pattern matching attempts
    let foundMatch = false;
    
    for (const pattern of contextPatterns) {
      const match = statusAreaText.match(pattern);
      if (match) {
        const percentage = parseInt(match[1]);
        log.verbose(`[Context Debug] ✓ MATCHED pattern: ${pattern.source}`);
        log.verbose(`[Context Debug] ✓ Extracted: ${percentage}% from "${match[0]}"`);
        foundMatch = true;
        
        // AUTO-COMPACT FAILSAFE: If context is critically low, trigger compact automatically
        // IMPORTANT: Only trigger if BOTH conditions are met:
        // 1. Auto-compact is enabled in config
        // 2. Loop is actually running
        const sessionConfig = await getSessionConfig(session, { loopConfig });
        const threshold = sessionConfig.autoCompactThreshold || 5;

        // Check if auto-compact is enabled
        if (sessionConfig.enableAutoCompact !== true) {
          log.verbose(`[Auto-Compact] Disabled for session ${session} (context: ${percentage}%)`);
        } else {
          // Check if loop is running
          const loopInfo = sessionLoops.get(session);
          const isLoopRunning = loopInfo && !loopInfo.paused;

          if (!isLoopRunning) {
            log.verbose(`[Auto-Compact] Loop not running for session ${session}, skipping (context: ${percentage}%)`);
          } else if (percentage < threshold && percentage >= 0) {
            // Both checks passed: auto-compact is enabled AND loop is running
            log.info(`[Auto-Compact] Context critically low (${percentage}% < ${threshold}%) for session ${session}`);
            // Use unified compact function
            sendCompactIfNeeded(session, 'low-context').then(sent => {
              if (sent) {
                log.info(`[Auto-Compact] Successfully triggered compact for ${session}`);
              }
            }).catch(err => {
              log.error(`[Auto-Compact] Error: ${err.message}`);
            });
          }
        }
        
        return percentage;
      }
    }
    
    // TEMPORARY DEBUG: Log when no match found
    if (!foundMatch) {
      log.verbose(`[Context Debug] ✗ No context percentage found in status area`);
      // Check if "context" word appears at all
      if (statusAreaText.toLowerCase().includes('context')) {
        log.verbose(`[Context Debug] Word "context" found but no percentage matched`);
        // Show where context appears
        const contextIndex = statusAreaText.toLowerCase().indexOf('context');
        const contextSnippet = statusAreaText.substring(Math.max(0, contextIndex - 20), Math.min(statusAreaText.length, contextIndex + 50));
        log.verbose(`[Context Debug] Context snippet: "${contextSnippet}"`);
      } else {
        log.verbose(`[Context Debug] Word "context" not found in status area at all`);
      }
    }
    
    return null;
  } catch (e) {
    log.error('Error scraping context from tmux:', e);
    return null;
  }
}

// Detect if Claude is showing an interactive prompt waiting for user input
function detectInteractivePrompt(visibleContent) {
  try {
    // FAST PATH: Selection marker (❯) is the most reliable indicator
    // If we see ❯ inside a box (rounded OR straight-line), it's definitely an interactive prompt
    const hasSelectionMarker = visibleContent.includes('❯');
    const hasBox = (visibleContent.includes('╭') && visibleContent.includes('╰')) ||
                   /─{10,}/.test(visibleContent);  // Also match straight-line separators

    if (hasSelectionMarker && hasBox) {
      log.verbose('[Interactive Prompt] Fast-path detected: ❯ marker found in box');

      // Check if "Yes" option has the selection marker (is default)
      const hasDefaultYes = visibleContent.split('\n').some(line =>
        line.includes('❯') && line.toLowerCase().includes('yes')
      );

      return {
        detected: true,
        type: 'prompt',
        content: 'Selection prompt detected (fast-path)',
        hasDefaultYes: hasDefaultYes,
        fastPath: true
      };
    }

    // FALLBACK: Complex box parsing for edge cases where ❯ might not appear
    // Find ALL box boundaries (to handle nested boxes AND straight-line separators)
    // Matches either rounded corners (╭───╮) OR straight lines (────────)
    const allBoxTops = [...visibleContent.matchAll(/(╭─{3,}╮|─{10,})/g)];
    const allBoxBottoms = [...visibleContent.matchAll(/(╰─{3,}╯|─{10,})/g)];
    
    if (allBoxTops.length === 0 || allBoxBottoms.length === 0) {
      return null; // No box found
    }
    
    // For nested boxes (like edit confirmations), we want the OUTERMOST box
    // but we need to check the content near the LAST bottom border for the prompt
    const lastBoxBottom = allBoxBottoms[allBoxBottoms.length - 1];
    const firstBoxTop = allBoxTops[0];
    
    // Extract content between first top and last bottom (entire outer box)
    const boxStartIndex = firstBoxTop.index + firstBoxTop[0].length;
    const boxEndIndex = lastBoxBottom.index;
    
    if (boxStartIndex >= boxEndIndex) {
      return null; // Invalid box boundaries
    }
    
    const boxContent = visibleContent.substring(boxStartIndex, boxEndIndex);
    
    // Split into lines and filter for lines that are part of the box (start with │)
    const boxLines = boxContent.split('\n')
      .filter(line => line.includes('│'))
      .map(line => {
        // Extract content between │ characters
        const match = line.match(/│\s*(.*?)\s*│/);
        return match ? match[1].trim() : '';
      })
      .filter(line => line.length > 0);
    
    if (boxLines.length === 0) {
      return null; // Empty box
    }
    
    // Check for interactive prompt patterns
    const promptIndicators = {
      // Direct questions
      hasQuestion: boxLines.some(line => line.endsWith('?')),
      
      // Numbered choices with selection marker
      hasNumberedChoices: boxLines.some(line => /^[❯\s]*\d+\./.test(line)),
      
      // Selection marker (❯)
      hasSelectionMarker: boxLines.some(line => line.includes('❯')),
      
      // Common prompt phrases
      hasPromptPhrase: boxLines.some(line => {
        const lower = line.toLowerCase();
        return lower.includes('do you want') ||
               lower.includes('would you like') ||
               lower.includes('should i') ||
               lower.includes('confirm') ||
               lower.includes('proceed') ||
               lower.includes('continue') ||
               lower.includes('make this edit') ||
               lower.includes('make these edits');
      }),
      
      // Escape option indicator
      hasEscapeOption: boxLines.some(line => line.includes('(esc)') || line.includes('escape')),
      
      // Yes/No options
      hasYesNoOptions: boxLines.some(line => {
        const lower = line.toLowerCase();
        return (lower.includes('yes') || lower.includes('no')) && /\d+\./.test(line);
      }),
      
      // Edit confirmation specific patterns
      hasAllowAllOption: boxLines.some(line => {
        const lower = line.toLowerCase();
        return lower.includes('allow all') || lower.includes('during this session');
      }),
      
      // Edit file pattern
      isEditConfirmation: boxLines.some(line => {
        const lower = line.toLowerCase();
        return lower.includes('edit file') || lower.includes('make this edit') || lower.includes('make these edits');
      })
    };
    
    // Determine if this is an interactive prompt
    const isInteractive = (
      promptIndicators.hasQuestion ||
      (promptIndicators.hasNumberedChoices && promptIndicators.hasSelectionMarker) ||
      (promptIndicators.hasPromptPhrase && promptIndicators.hasYesNoOptions)
    );
    
    if (!isInteractive) {
      return null;
    }
    
    // Determine prompt type
    let promptType = 'question';
    if (promptIndicators.isEditConfirmation) {
      promptType = 'edit-confirmation';
    } else if (promptIndicators.hasNumberedChoices && promptIndicators.hasSelectionMarker) {
      promptType = 'choice';
    } else if (promptIndicators.hasYesNoOptions) {
      promptType = 'confirmation';
    }
    
    // Check if "Yes" is the default (has the selection marker)
    const hasDefaultYes = boxLines.some(line => 
      line.includes('❯') && line.toLowerCase().includes('yes')
    );
    
    return {
      detected: true,
      type: promptType,
      content: boxLines.join('\n'),
      hasDefaultYes: hasDefaultYes,
      indicators: promptIndicators
    };
    
  } catch (e) {
    log.error('Error detecting interactive prompt:', e);
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
    
    // Calculate characters since last compact from conversation file
    let charsSinceCompact = 0;
    try {
      // Get current conversation
      const projectsDir = path.join(require('os').homedir(), '.claude', 'projects');
      const projectPaths = [
        path.join(projectsDir, '-home-michael-InfiniQuest-tmp-claudeLoop-dashboard'),
        path.join(projectsDir, '-home-michael-InfiniQuest')
      ];
      
      let conversationFile = null;
      let mostRecentTime = 0;
      
      // Find most recent conversation file
      for (const projectPath of projectPaths) {
        try {
          const files = await fs.readdir(projectPath);
          const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
          
          for (const file of jsonlFiles) {
            const filePath = path.join(projectPath, file);
            const stat = await fs.stat(filePath);
            if (stat.mtime > mostRecentTime) {
              mostRecentTime = stat.mtime;
              conversationFile = filePath;
            }
          }
        } catch (e) {
          // Skip if directory doesn't exist
        }
      }
      
      if (conversationFile) {
        // Read the conversation file and count characters since last compact
        const content = await fs.readFile(conversationFile, 'utf8');
        const lines = content.trim().split('\n');
        let lastCompactIndex = -1;
        
        // Find the last compact message (working backwards)
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const msg = JSON.parse(lines[i]);
            if (msg.type === 'summary' || 
                (msg.content && typeof msg.content === 'string' && 
                 msg.content.includes('This session is being continued from a previous conversation'))) {
              lastCompactIndex = i;
              break;
            }
          } catch (e) {
            // Skip malformed lines
          }
        }
        
        // Count characters from messages after the last compact
        for (let i = lastCompactIndex + 1; i < lines.length; i++) {
          try {
            const msg = JSON.parse(lines[i]);
            // Count content from user and assistant messages
            if (msg.type === 'user' || msg.type === 'assistant') {
              const content = msg.content || msg.message || '';
              const textContent = typeof content === 'string' ? content : 
                                  (content.content || JSON.stringify(content));
              charsSinceCompact += textContent.length;
            }
          } catch (e) {
            // Skip malformed lines
          }
        }
      }
    } catch (e) {
      log.error('Error calculating chars since compact:', e);
    }
    
    // First try to scrape actual context from tmux
    const scrapedContext = await scrapeContextFromTmux(session);
    if (scrapedContext !== null) {
      log.debug(`[Context Source] Using TMUX scraping for ${session}: ${scrapedContext}%`);
      return {
        contextPercent: scrapedContext,
        charsSinceCompact: charsSinceCompact,
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
    
    log.debug(`[Context Source] Using LOG fallback for ${session}: ${Math.round(percentRemaining)}% (bytes after compact: ${bytesAfterCompact}`);
    
    return {
      contextPercent: Math.round(percentRemaining),
      charsSinceCompact: charsSinceCompact,
      timestamp: new Date().toISOString(),
      logSize,
      lastCompact: lastCompactLine >= 0 ? lines.length - lastCompactLine : null
    };
  } catch (e) {
    return { contextPercent: 100, charsSinceCompact: 0, timestamp: new Date().toISOString() };
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
    log.error('Error reading logs:', e);
    return '';
  }
}

async function getConditionalMessage(sessionName = null) {
  const now = new Date();
  const hour = now.getHours();
  
  // Load session-specific config using helper
  const sessionConfig = await getSessionConfig(sessionName, { loopConfig });
  const config = sessionConfig.conditionalMessages || loopConfig.conditionalMessages;
  log.debug(`Using config for ${sessionName}:`, config.standardMessage);
  
  // Helper function to add auto-finish instruction to any message
  function addAutoFinishInstruction(message) {
    if (config.lowContextMessage?.autoFinish) {
      message += '\n\nIf you\'ve completed all of your todo items and can\'t think of anything you should do right now to improve the project, then respond with exactly: F-i-n-i-s-h-e-d everything for n-o-w! (but without the hyphens)';
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
      return addAutoFinishInstruction(config.lowContextMessage.message);
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

// Track auto-accept timers so they can be cancelled on stop
const autoAcceptTimers = new Map(); // session -> timeoutId

// Track webhook status for each session
const webhookState = {}; // session -> { reviewCount, lastStatus, lastTaskHash, lastStatusTime }

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
    log.error('Failed to save active loops:', e);
  }
}

function isScheduleActive(session, config) {
  // If no schedule config, assume always active
  if (!config || !config.schedule || !config.schedule.enabled) {
    return true;
  }
  
  // Get current time in minutes since midnight
  const now = new Date();
  const currentMinute = now.getHours() * 60 + now.getMinutes();
  
  // Check if this minute is active in the schedule
  // config.schedule.minutes is an array of 1440 booleans (one per minute of day)
  if (config.schedule.minutes && Array.isArray(config.schedule.minutes)) {
    return config.schedule.minutes[currentMinute] || false;
  }
  
  // Default to active if schedule data is missing
  return true;
}

async function startLoop(session = 'claude', config = loopConfig) {
  // Check if loop already exists for this session
  if (sessionLoops.has(session)) {
    log.debug('Loop already running for session: ' + session);
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
  let initialMessageTimeout = null;
  if (!config.startWithDelay) {
    // If NOT starting with delay, send after safety delay (30 seconds)
    initialMessageTimeout = setTimeout(async () => {
      try {
        const message = await getConditionalMessage(session) || config.customMessage;
        if (message) {
          await sendCustomMessage(message, session);
          log.info(`Sent initial message to ${session}: ${message} (after safety delay)`);
        }
        // Update last message time and next message time after sending
        const loopInfo = sessionLoops.get(session);
        if (loopInfo) {
          loopInfo.lastMessageTime = Date.now();
          loopInfo.nextMessageTime = new Date(Date.now() + config.delayMinutes * 60 * 1000);
          // Clear the reference since it executed
          loopInfo.initialMessageTimeout = null;
        }
      } catch (error) {
        log.error('Error sending initial message for ' + session + ':', error);
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
      if (config.schedule && config.schedule.enabled) {
        const scheduleActive = isScheduleActive(session, config);
        if (!scheduleActive) {
          log.debug(`Session ${session}: Outside scheduled hours, skipping`);
          return;
        }
      }
      
      // Check if Claude is busy - if so, delay the message
      initActivityState(session);
      const actState = activityState.sessions[session];
      if (actState && actState.isBusy) {
        log.debug(`Session ${session}: Claude is busy, delaying message by 30 seconds`);
        // Reschedule for 30 seconds later
        const loopInfoUpdate = sessionLoops.get(session);
        if (loopInfoUpdate) {
          loopInfoUpdate.nextMessageTime = new Date(Date.now() + 30000);
        }
        return;
      }
      
      // Get the best conditional message for this session
      const message = await getConditionalMessage(session) || config.customMessage;
      
      log.debug(`Loop iteration for ${session}: message="${message}"`);
      
      // Only send if we have a message
      if (message) {
        // Send message to the specific session
        await sendCustomMessage(message, session);
        log.info(`Sent message to ${session}: ${message}`);
      } else {
        log.debug(`No message to send for ${session}`);
      }
      
      // Update last message time and next message time
      const loopInfoUpdate = sessionLoops.get(session);
      if (loopInfoUpdate) {
        loopInfoUpdate.lastMessageTime = Date.now();
        loopInfoUpdate.nextMessageTime = new Date(Date.now() + config.delayMinutes * 60 * 1000);
      }
      
    } catch (error) {
      log.error('Loop error for session ' + session + ':', error);
    }
  }, config.delayMinutes * 60 * 1000); // Convert minutes to milliseconds
  
  // Store loop info
  sessionLoops.set(session, {
    intervalId: loopInterval,
    initialMessageTimeout: initialMessageTimeout,
    startTime: new Date(),
    nextMessageTime: firstMessageTime,
    delayMinutes: config.delayMinutes,
    paused: false
  });
  
  // Save to file for persistence
  await saveActiveLoops();
  
  log.info('Started loop for session: ' + session);
}

async function stopLoop(session = null) {
  try {
    if (session) {
      // Stop specific session loop
      const loopInfo = sessionLoops.get(session);
      if (loopInfo) {
        // Clear the interval timer
        if (loopInfo.intervalId) {
          clearInterval(loopInfo.intervalId);
        }
        // Clear the initial message timeout if it exists
        if (loopInfo.initialMessageTimeout) {
          clearTimeout(loopInfo.initialMessageTimeout);
          log.debug('Cancelled pending initial message for session: ' + session);
        }
        sessionLoops.delete(session);
        log.info('Stopped loop for session: ' + session);
      }

      // Cancel any pending auto-accept timer for this session
      if (autoAcceptTimers.has(session)) {
        clearTimeout(autoAcceptTimers.get(session));
        autoAcceptTimers.delete(session);
        log.info('[Auto-Accept] Cancelled pending auto-accept timer for session: ' + session);
      }

      // Also run the stop script to clean up lock files
      try {
        await execAsync(`/home/michael/InfiniQuest/tmp/claudeLoop/stop-claude-loop.sh ${session}`);
        log.debug('Cleaned up lock files for session: ' + session);
      } catch (e) {
        log.error('Failed to run stop script:', e);
      }
    } else {
      // Stop all session loops
      if (sessionLoops && sessionLoops.size > 0) {
        for (const [sess, loopInfo] of sessionLoops.entries()) {
          if (loopInfo) {
            if (loopInfo.intervalId) {
              clearInterval(loopInfo.intervalId);
            }
            if (loopInfo.initialMessageTimeout) {
              clearTimeout(loopInfo.initialMessageTimeout);
              log.debug('Cancelled pending initial message for session: ' + sess);
            }
          }
        }
        sessionLoops.clear();
      }

      // Cancel all pending auto-accept timers
      if (autoAcceptTimers.size > 0) {
        for (const [sess, timerId] of autoAcceptTimers.entries()) {
          clearTimeout(timerId);
          log.info('[Auto-Accept] Cancelled pending auto-accept timer for session: ' + sess);
        }
        autoAcceptTimers.clear();
      }

      log.info('Stopped all loops');
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
    log.error('Error in stopLoop:', error);
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
    log.debug('No pause state to restore');
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
    log.error('Failed to start auto-resume:', error);
    throw error;
  }
}

// State for tracking context and compact operations
const contextState = {
  sessions: {}  // Track per-session state
};

// State for tracking auto-accept operations
const autoAcceptState = {
  sessions: {}  // Track per-session auto-accept state
};

// State for tracking Claude's activity (to avoid interrupting when busy)
const activityState = {
  sessions: {}  // Track per-session activity state
};

// Initialize context state for a session
function initContextState(session) {
  if (!contextState.sessions[session]) {
    contextState.sessions[session] = {
      currentPercent: 100,
      linesAfterCompact: 1000,
      lastCompactTime: null,
      lastCompactCommandTime: null,  // Track when we last sent /compact
      compactDebounceMinutes: 5,  // Wait 5 minutes before sending another /compact
      rescanPending: false,  // Track if conversation rescan is scheduled
      compactInProgress: false  // Add flag to prevent double sends
    };
  }
}

// Initialize activity state for a session
function initActivityState(session) {
  if (!activityState.sessions[session]) {
    activityState.sessions[session] = {
      lastActivityTime: null,
      lastCheckTime: null,
      isBusy: false
    };
  }
}

// Detect if Claude is actively working based on output
function detectClaudeActivity(output, session) {
  initActivityState(session);
  const state = activityState.sessions[session];
  
  // The definitive pattern that Claude is actively processing
  // Looking for variations like:
  // (esc to interrupt)
  // (esc to interrupt · /todos)
  // (ESC to interrupt)
  const busyPattern = /\(.*esc\s+to\s+interrupt.*\)/i;
  
  // Efficiently search only the relevant part of output
  // The interrupt indicator appears just above the input box (╭─)
  // So we only need to check the last ~20 lines
  const lines = output.split('\n');
  const lastLines = lines.slice(-20).join('\n');
  
  // Look for the input box border to know we're in the right area
  const hasInputBox = /╭─/.test(lastLines);
  
  // Only search for busy pattern if we can see the input area
  let hasBusyIndicator = false;
  if (hasInputBox) {
    // Search only in the last 20 lines where the indicator would appear
    hasBusyIndicator = busyPattern.test(lastLines);
  } else {
    // If we can't see the input box, check the whole output as fallback
    // (this handles cases where the terminal might be scrolled)
    hasBusyIndicator = busyPattern.test(output);
  }
  
  // Update busy state
  state.isBusy = hasBusyIndicator;
  state.lastCheckTime = Date.now();
  
  if (hasBusyIndicator) {
    state.lastActivityTime = Date.now();
    log.info(`[Activity] Session ${session}: Claude is busy (interrupt prompt detected)`);
  } else if (state.lastActivityTime) {
    const idleTime = (Date.now() - state.lastActivityTime) / 1000;
    log.info(`[Activity] Session ${session}: Claude is idle (${idleTime.toFixed(1)}s since last busy)`);
  }
  
  return state.isBusy;
}

// Unified function to send /compact command with proper debouncing
async function sendCompactIfNeeded(session, reason) {
  // Initialize context state if needed
  initContextState(session);
  const sessionState = contextState.sessions[session];
  
  // Check if compact is already in progress
  if (sessionState.compactInProgress) {
    log.debug(`[Compact] Already in progress for session ${session}, skipping (reason: ${reason})`);
    return false;
  }
  
  // Check debounce
  const now = new Date();
  const timeSinceLastCompact = sessionState.lastCompactCommandTime ? 
    (now - sessionState.lastCompactCommandTime) / 1000 / 60 : Infinity; // minutes
  
  // Always use 5 minutes debounce regardless of reason to avoid double compacts
  const debounceMinutes = 5;
  
  if (timeSinceLastCompact < debounceMinutes) {
    const remainingTime = Math.ceil(debounceMinutes - timeSinceLastCompact);
    log.debug(`[Compact] Debouncing - ${remainingTime} min remaining for session ${session} (reason: ${reason})`);
    return false;
  }
  
  // Set in-progress flag BEFORE sending
  sessionState.compactInProgress = true;
  
  log.info(`[Compact] Sending /compact to session ${session} (reason: ${reason})`);
  
  try {
    // Don't retry Enter for compact commands - they're quick and don't need it
    await sendCustomMessage('/compact', session, true);
    // Update the last compact command time
    sessionState.lastCompactCommandTime = now;
    // Mark that we've compacted
    onCompact(session);
    log.info(`[Compact] Successfully sent /compact to ${session}`);
    
    // Clear in-progress flag after a short delay (to handle any race conditions)
    setTimeout(() => {
      sessionState.compactInProgress = false;
    }, 5000); // 5 seconds
    
    return true;
  } catch (err) {
    log.error(`[Compact] Failed to send /compact to ${session}: ${err.message}`);
    // Clear in-progress flag on error
    sessionState.compactInProgress = false;
    return false;
  }
}

// Track when a compact happens
function onCompact(session) {
  initContextState(session);
  const state = contextState.sessions[session];
  
  // Skip if rescan already pending
  if (state.rescanPending) {
    log.info(`[Compact] Rescan already scheduled for ${session}, skipping duplicate`);
    return;
  }
  
  // Set flag and update state
  state.rescanPending = true;
  state.linesAfterCompact = 0;
  state.lastCompactTime = new Date();
  state.currentPercent = 100;
  log.info(`[Context] Compact detected for session ${session}`);
  
  // Schedule conversation rescan after delay (5 minutes)
  const rescanDelay = 5 * 60 * 1000; // 5 minutes
  setTimeout(async () => {
    // Clear flag when rescan executes
    state.rescanPending = false;
    
    log.info(`[Compact] Triggering conversation rescan after compact for ${session}`);
    
    // Use existing auto-associate logic to find the new forked conversation
    try {
      const response = await fetch(`http://localhost:3335/api/conversation/auto-associate?session=${session}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      
      if (response.ok) {
        const result = await response.json();
        log.info(`[Compact] Conversation rescan complete: ${result.conversationId || 'No new conversation found'}`);
        
        // Update the session config with new conversation ID
        if (result.conversationId) {
          const config = sessionConfigs[session] || {};
          config.conversationId = result.conversationId;
          sessionConfigs[session] = config;
        }
      }
    } catch (error) {
      log.error('[Compact] Failed to rescan conversation:', error);
    }
  }, rescanDelay);
}

// Track lines sent after compact
function onMessageSent(session) {
  initContextState(session);
  contextState.sessions[session].linesAfterCompact++;
}

// Get the active conditional message for a session
async function getActiveConditionalMessage(session = 'claude') {
  try {
    // Load config for this session using helper
    const config = await getSessionConfig(session, { loopConfig });
    
    if (!config.conditionalMessages) {
      return null;
    }
    
    const messages = config.conditionalMessages;
    
    // Get current context
    initContextState(session);
    const state = contextState.sessions[session];
    
    // Try to get fresh context from tmux
    const freshContext = await scrapeContextFromTmux(session);
    if (freshContext !== null) {
      state.currentPercent = freshContext;
    }
    
    const contextPercent = state.currentPercent;
    const linesAfterCompact = state.linesAfterCompact;
    const hour = new Date().getHours();
    
    log.info(`[Conditional] Session ${session} - Context: ${contextPercent}%, Lines after compact: ${linesAfterCompact}`);

    // Check if session is idle
    let isIdle = false;
    let idleTime = 0;
    if (state.lastActivityTime) {
      idleTime = (Date.now() - state.lastActivityTime) / 1000; // seconds
      isIdle = !state.isBusy && idleTime > 0;
    }

    // Priority 1: On Idle message (highest priority when idle)
    if (messages.onIdleMessage?.enabled && isIdle) {
      const threshold = messages.onIdleMessage.idleThresholdSeconds || 30;
      if (idleTime >= threshold) {
        log.info(`[Conditional] Using on-idle message (idle for ${idleTime.toFixed(1)}s)`);
        return {
          type: 'onIdle',
          message: messages.onIdleMessage.message,
          priority: 1,
          idleTime: idleTime
        };
      }
    }

    // Priority 2: After Compact message
    if (messages.afterCompactMessage?.enabled &&
        linesAfterCompact <= messages.afterCompactMessage.linesAfterCompact) {
      log.info(`[Conditional] Using after-compact message`);
      return {
        type: 'afterCompact',
        message: messages.afterCompactMessage.message,
        priority: 2
      };
    }
    
    // Priority 3: Low Context message
    if (messages.lowContextMessage?.enabled &&
        contextPercent <= messages.lowContextMessage.threshold) {
      log.info(`[Conditional] Using low-context message`);
      let message = messages.lowContextMessage.message;

      if (messages.lowContextMessage.autoCompact) {
        message += '\n\nIMPORTANT: If you think it would be helpful, please say "Let\'s compact!" to trigger a context reset.';
      }

      if (messages.lowContextMessage.autoFinish) {
        message += '\n\nIMPORTANT: If you\'ve completed all tasks, please type: F-i-n-i-s-h-e-d everything for n-o-w! (without the hyphens)';
      }

      return {
        type: 'lowContext',
        message: message,
        priority: 3,
        autoCompact: messages.lowContextMessage.autoCompact,
        autoFinish: messages.lowContextMessage.autoFinish
      };
    }

    // Priority 4: Time-based messages
    if (messages.morningMessage?.enabled &&
        hour >= messages.morningMessage.startHour &&
        hour < messages.morningMessage.endHour) {
      log.info(`[Conditional] Using morning message`);
      return {
        type: 'morning',
        message: messages.morningMessage.message,
        priority: 4
      };
    }

    if (messages.afternoonMessage?.enabled &&
        hour >= messages.afternoonMessage.startHour &&
        hour < messages.afternoonMessage.endHour) {
      log.info(`[Conditional] Using afternoon message`);
      return {
        type: 'afternoon',
        message: messages.afternoonMessage.message,
        priority: 4
      };
    }

    if (messages.eveningMessage?.enabled &&
        hour >= messages.eveningMessage.startHour &&
        hour < messages.eveningMessage.endHour) {
      log.info(`[Conditional] Using evening message`);
      return {
        type: 'evening',
        message: messages.eveningMessage.message,
        priority: 4
      };
    }

    // Priority 5: Standard message
    if (messages.standardMessage?.enabled) {
      log.info(`[Conditional] Using standard message`);
      return {
        type: 'standard',
        message: messages.standardMessage.message,
        priority: 5
      };
    }
    
    log.info(`[Conditional] No conditional message active`);
    return null;
    
  } catch (error) {
    log.error('[Conditional] Error getting active message:', error);
    return null;
  }
}

async function sendCustomMessage(message, session = 'claude', isManualSend = false) {
  // Use our safe middleware script to handle all special characters properly
  const scriptPath = path.join(__dirname, 'tmux-send-safe.sh');
  
  // Check for compact trigger in message BEFORE incrementing counter
  if (message.toLowerCase().includes("let's compact") || 
      message.toLowerCase().includes("compact!") ||
      message.toLowerCase().includes("/compact")) {
    onCompact(session);
  } else {
    // Only increment if not a compact message
    onMessageSent(session);
  }
  
  try {
    // Use spawn to pipe the message via stdin, avoiding all shell escaping issues
    const { spawn } = require('child_process');
    
    return new Promise((resolve, reject) => {
      // Get send delay from config (default 5 seconds)
      const sendDelay = loopConfig.messageSendDelay || 5;
      // Only retry Enter for auto-loop messages, not manual sends
      const retryEnter = (!isManualSend && loopConfig.retryEnterKey !== false) ? 'true' : 'false';
      
      if (isManualSend) {
        log.debug(`[SendMessage] Manual send to ${session}, retry disabled`);
      } else {
        log.debug(`[SendMessage] Auto-loop send to ${session}, retry=${retryEnter}`);
      }
      
      const proc = spawn(scriptPath, [session, '', sendDelay.toString(), retryEnter]);
      let stdout = '';
      let stderr = '';

      // Track this process for potential cancellation (panic stop)
      if (!activeSendProcesses.has(session)) {
        activeSendProcesses.set(session, new Set());
      }
      activeSendProcesses.get(session).add(proc);

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        // Remove from active processes
        if (activeSendProcesses.has(session)) {
          activeSendProcesses.get(session).delete(proc);
        }

        if (code !== 0) {
          const error = new Error(`tmux-send-safe.sh exited with code ${code}`);
          error.stderr = stderr;
          reject(error);
        } else {
          log.info('Message sent:', stdout.trim() || 'Success');
          if (stderr) {
            log.warn('Tmux send warning:', stderr);
          }
          // Track the message for session matching
          sessionMatcher.recordLoopMessage(session, message);
          resolve();
        }
      });

      proc.on('error', (err) => {
        // Remove from active processes on error too
        if (activeSendProcesses.has(session)) {
          activeSendProcesses.get(session).delete(proc);
        }
        reject(err);
      });
      
      // Write the message to stdin and close it
      proc.stdin.write(message);
      proc.stdin.end();
    });
  } catch (error) {
    log.error('Failed to send message to tmux:', error);
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
  log.error('Failed to load dashboard.html:', error);
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
        log.error('Error serving dashboard-utils.js:', err);
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
        log.error('Error serving dashboard-styles.css:', err);
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
        log.error('Error serving dashboard-api.js:', err);
        res.writeHead(404);
        res.end('Not found');
      });
    return;
  }
  
  // Serve dashboard-schedule.js
  if (pathname === '/dashboard-schedule.js') {
    const schedulePath = path.join(__dirname, 'dashboard-schedule.js');
    fs.readFile(schedulePath, 'utf8')
      .then(data => {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(data);
      })
      .catch(err => {
        log.error('Error serving dashboard-schedule.js:', err);
        res.writeHead(404);
        res.end('Not found');
      });
    return;
  }
  
  // Serve dashboard-conditional.js
  if (pathname === '/dashboard-conditional.js') {
    const conditionalPath = path.join(__dirname, 'dashboard-conditional.js');
    fs.readFile(conditionalPath, 'utf8')
      .then(data => {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(data);
      })
      .catch(err => {
        log.error('Error serving dashboard-conditional.js:', err);
        res.writeHead(404);
        res.end('Not found');
      });
    return;
  }
  
  // Serve dashboard-conversations.js
  if (pathname === '/dashboard-conversations.js') {
    const conversationsPath = path.join(__dirname, 'dashboard-conversations.js');
    fs.readFile(conversationsPath, 'utf8')
      .then(data => {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(data);
      })
      .catch(err => {
        log.error('Error serving dashboard-conversations.js:', err);
        res.writeHead(404);
        res.end('Not found');
      });
    return;
  }
  
  // Serve dashboard-native-todos.js
  if (pathname === '/dashboard-native-todos.js') {
    const nativeTodosPath = path.join(__dirname, 'dashboard-native-todos.js');
    fs.readFile(nativeTodosPath, 'utf8')
      .then(data => {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(data);
      })
      .catch(err => {
        log.error('Error serving dashboard-native-todos.js:', err);
        res.writeHead(404);
        res.end('Not found');
      });
    return;
  }
  
  // Serve session-state.js
  if (pathname === '/session-state.js') {
    const sessionStatePath = path.join(__dirname, 'session-state.js');
    fs.readFile(sessionStatePath, 'utf8')
      .then(data => {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(data);
      })
      .catch(err => {
        log.error('Error serving session-state.js:', err);
        res.writeHead(404);
        res.end('Not found');
      });
    return;
  }
  
  // Serve dashboard-chat.js
  if (pathname === '/dashboard-chat.js') {
    const chatPath = path.join(__dirname, 'dashboard-chat.js');
    fs.readFile(chatPath, 'utf8')
      .then(data => {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(data);
      })
      .catch(err => {
        log.error('Error serving dashboard-chat.js:', err);
        res.writeHead(404);
        res.end('Not found');
      });
    return;
  }
  
  // Serve dashboard-tmux-status.js
  if (pathname === '/dashboard-tmux-status.js') {
    const tmuxStatusPath = path.join(__dirname, 'dashboard-tmux-status.js');
    fs.readFile(tmuxStatusPath, 'utf8')
      .then(data => {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(data);
      })
      .catch(err => {
        log.error('Error serving dashboard-tmux-status.js:', err);
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
        log.error('Error serving dashboard-main.js:', err);
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
  await sessionTracker.init(loopConfig);
  await sessionMatcher.init(loopConfig);
  
  // Restore active loops from persistent storage
  const activeLoops = await loadActiveLoops();
  for (const [session, info] of Object.entries(activeLoops)) {
    if (info.active) {
      log.info(`Restoring loop for session: ${session}${info.paused ? ' (paused)' : ''}`);
      try {
        // Load session-specific config using helper
        const sessionConfig = await getSessionConfig(session, { loopConfig });
        await startLoop(session, sessionConfig);
        
        // Restore paused state if it was paused
        if (info.paused && sessionLoops.has(session)) {
          const loopInfo = sessionLoops.get(session);
          loopInfo.paused = true;
          log.info(`Restored paused state for session: ${session}`);
        }
      } catch (e) {
        log.error(`Failed to restore loop for ${session}:`, e);
      }
    }
  }
  
  // Initialize history manager
  historyManager.init().then(() => {
    log.info('📝 History manager initialized');
  }).catch(err => {
    log.error('Failed to initialize history manager:', err);
  });
  
  server.listen(CONFIG.port, '0.0.0.0', () => {
    log.info('🎮 Claude Loop Unified Dashboard running at:');
    log.info('   - http://localhost:' + CONFIG.port);
    log.info('   - http://192.168.1.2:' + CONFIG.port);
    log.info('✨ Features:');
    log.info('   - Full configuration control');
    log.info('   - Real-time context monitoring');
    log.info('   - Custom messages on-the-fly');
    log.info('   - Start/stop/pause/resume');
    log.info('   - Persistent settings');
    log.info('   - Recently deleted todos (7-day retention)');
  });
  
  // Auto-cleanup deleted todos older than 7 days (runs daily)
  setInterval(async () => {
    try {
      await loadTodos();
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const beforeCount = todos.length;
      todos = todos.filter(t => 
        t.status !== 'deleted' || 
        !t.deleted_at || 
        t.deleted_at > sevenDaysAgo
      );
      const removedCount = beforeCount - todos.length;
      
      if (removedCount > 0) {
        await saveTodos();
        log.info(`[Todo Cleanup] Removed ${removedCount} old deleted todos`);
      }
    } catch (error) {
      log.error('[Todo Cleanup] Error:', error);
    }
  }, 24 * 60 * 60 * 1000); // Run once per day
  
  // Start periodic session matching (every 30 seconds)
  setInterval(async () => {
    try {
      // Get all unique working directories from active loops
      const workingDirs = new Set();
      for (const [session, loopInfo] of sessionLoops.entries()) {
        // Try to get working directory from session config using helper
        const sessionConfig = await getSessionConfig(session, { loopConfig });
        const workingDir = sessionConfig.workingDirectory || process.cwd();
        workingDirs.add(workingDir);
      }
      
      // Run matcher for each working directory
      for (const workingDir of workingDirs) {
        await sessionMatcher.matchConversationsToSessions(workingDir);
      }
    } catch (err) {
      log.error('Error in session matching:', err);
    }
  }, 30000); // Run every 30 seconds
});
