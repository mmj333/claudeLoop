#!/usr/bin/env node

/**
 * Tmux Utilities
 * Centralized tmux operations for Claude Loop Dashboard
 */

const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

/**
 * Send a command to a tmux session
 * @param {string} command - Command to send
 * @param {string} session - Tmux session name (default: 'claude')
 * @returns {Promise<object>} Success status
 */
async function sendCommand(command, session = 'claude') {
  try {
    // Escape single quotes in the command
    const escapedCommand = command.replace(/'/g, "'\\''");
    await execAsync(`tmux send-keys -t "${session}" '${escapedCommand}' Enter`);
    console.log(`[Tmux] Sent command to session ${session}: ${command}`);
    return { success: true };
  } catch (error) {
    console.error(`[Tmux] Failed to send command: ${error.message}`);
    throw error;
  }
}

/**
 * Send a key combination to a tmux session
 * @param {string} key - Key to send (e.g., 'C-c' for Ctrl+C)
 * @param {string} session - Tmux session name (default: 'claude')
 * @returns {Promise<object>} Success status
 */
async function sendKey(key, session = 'claude') {
  try {
    // Properly handle special keys
    const tmuxKey = key === 'C-c' ? 'C-c' : key;
    await execAsync(`tmux send-keys -t "${session}" ${tmuxKey}`);
    console.log(`[Tmux] Sent key ${key} to session ${session}`);
    return { success: true };
  } catch (error) {
    console.error(`[Tmux] Failed to send key: ${error.message}`);
    throw error;
  }
}

/**
 * Start Claude in a tmux session
 * @param {string} session - Tmux session name (default: 'claude')
 * @param {string} workingDir - Working directory to start in
 * @param {boolean} initialize - Whether to send /help to initialize conversation
 * @returns {Promise<object>} Success status
 */
async function startClaude(session = 'claude', workingDir = '/home/michael/InfiniQuest', initialize = true) {
  try {
    // First, make sure Claude is stopped
    await stopClaude(session).catch(() => {}); // Ignore error if not running
    
    // Wait a moment for clean stop
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Change to the working directory
    await sendCommand(`cd ${workingDir}`, session);
    
    // Then send the claude command
    await sendCommand('claude', session);
    
    if (initialize) {
      // Wait for Claude to start, then send /help to initialize conversation
      await new Promise(resolve => setTimeout(resolve, 1500));
      await sendCommand('/help', session);
      console.log(`[Tmux] Started Claude with /help initialization in session ${session}`);
    }
    
    console.log(`[Tmux] Started Claude in session ${session} at ${workingDir}`);
    return { 
      success: true, 
      initialized: initialize,
      note: initialize ? 'Conversation initialized - ready for auto-association' : null
    };
  } catch (error) {
    console.error(`[Tmux] Failed to start Claude: ${error.message}`);
    throw error;
  }
}

/**
 * Stop Claude in a tmux session (sends Ctrl+C twice)
 * @param {string} session - Tmux session name (default: 'claude')
 * @returns {Promise<object>} Success status
 */
async function stopClaude(session = 'claude') {
  try {
    // Send Ctrl+C twice to ensure Claude stops
    await sendKey('C-c', session);
    await new Promise(resolve => setTimeout(resolve, 100)); // Small delay
    await sendKey('C-c', session);
    console.log(`[Tmux] Stopped Claude in session ${session}`);
    return { success: true };
  } catch (error) {
    console.error(`[Tmux] Failed to stop Claude: ${error.message}`);
    throw error;
  }
}

/**
 * Send compact command to Claude
 * @param {string} session - Tmux session name (default: 'claude')
 * @returns {Promise<object>} Success status
 */
async function sendCompact(session = 'claude') {
  try {
    await sendCommand('/compact', session);
    console.log(`[Tmux] Sent /compact command to session ${session}`);
    return { success: true };
  } catch (error) {
    console.error(`[Tmux] Failed to send compact: ${error.message}`);
    throw error;
  }
}

/**
 * Get tmux pane output
 * @param {string} session - Tmux session name
 * @param {number} lines - Number of lines to capture (0 for all)
 * @returns {Promise<string>} Pane output
 */
async function getPaneOutput(session = 'claude', lines = 500) {
  try {
    const captureCmd = lines > 0 
      ? `tmux capture-pane -t "${session}" -p -S -${lines}`
      : `tmux capture-pane -t "${session}" -p -S -`;
    
    const { stdout } = await execAsync(captureCmd);
    return stdout;
  } catch (error) {
    console.error(`[Tmux] Failed to get pane output: ${error.message}`);
    throw error;
  }
}

/**
 * List all tmux sessions
 * @returns {Promise<string[]>} Array of session names
 */
async function listSessions() {
  try {
    const { stdout } = await execAsync('tmux list-sessions -F "#{session_name}" 2>/dev/null || echo ""');
    return stdout.trim().split('\n').filter(s => s);
  } catch (error) {
    // No sessions exist
    return [];
  }
}

/**
 * Check if a tmux session exists
 * @param {string} session - Session name to check
 * @returns {Promise<boolean>} True if session exists
 */
async function sessionExists(session) {
  const sessions = await listSessions();
  return sessions.includes(session);
}

/**
 * Create a new tmux session if it doesn't exist
 * @param {string} session - Session name
 * @param {string} workingDir - Starting directory
 * @returns {Promise<object>} Success status
 */
async function ensureSession(session, workingDir = '/home/michael/InfiniQuest') {
  try {
    const exists = await sessionExists(session);
    if (!exists) {
      await execAsync(`tmux new-session -d -s "${session}" -c "${workingDir}"`);
      console.log(`[Tmux] Created new session ${session} in ${workingDir}`);
    }
    return { success: true, created: !exists };
  } catch (error) {
    console.error(`[Tmux] Failed to ensure session: ${error.message}`);
    throw error;
  }
}

/**
 * Restart Claude with resume in a tmux session
 * @param {string} session - Tmux session name (default: 'claude')
 * @param {string} workingDir - Working directory to start in
 * @param {string} conversationId - Conversation ID to resume
 * @returns {Promise<object>} Success status with new conversation info
 */
async function restartClaude(session = 'claude', workingDir = '/home/michael/InfiniQuest', conversationId = null) {
  try {
    // First, make sure Claude is stopped
    await stopClaude(session).catch(() => {}); // Ignore error if not running
    
    // Wait a moment for clean stop
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Change to the working directory
    await sendCommand(`cd ${workingDir}`, session);
    
    if (conversationId) {
      // Start claude with resume option
      await sendCommand(`claude --resume ${conversationId}`, session);
      
      // Send /help to activate Claude
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for Claude to start
      await sendCommand('/help', session);
      
      console.log(`[Tmux] Restarted Claude in session ${session} with conversation ${conversationId}`);
      return { 
        success: true, 
        resumed: true,
        conversationId: conversationId,
        note: 'Claude will create a fork - update conversation association after restart'
      };
    } else {
      // Just start Claude normally
      await sendCommand('claude', session);
      console.log(`[Tmux] Restarted Claude in session ${session} (no resume)`);
      return { success: true, resumed: false };
    }
  } catch (error) {
    console.error(`[Tmux] Failed to restart Claude: ${error.message}`);
    throw error;
  }
}

module.exports = {
  sendCommand,
  sendKey,
  startClaude,
  stopClaude,
  restartClaude,
  sendCompact,
  getPaneOutput,
  listSessions,
  sessionExists,
  ensureSession
};