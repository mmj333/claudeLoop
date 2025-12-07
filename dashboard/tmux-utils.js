#!/usr/bin/env node

/**
 * Tmux Utilities
 * Centralized tmux operations for Claude Loop Dashboard
 */

const { exec, spawn } = require('child_process');
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
    // Check if it's a control sequence or special key (starts with C-, M-, or is a named key)
    const isControlSequence = key.match(/^(C-|M-|S-)/);
    const isSpecialKey = ['Enter', 'Tab', 'Escape', 'BSpace', 'Up', 'Down', 'Left', 'Right', 'BTab'].includes(key);

    if (isControlSequence || isSpecialKey) {
      // Control sequences and special keys - use send-keys directly
      await execAsync(`tmux send-keys -t "${session}" ${key}`);
      console.log(`[Tmux] Sent key ${key} to session ${session}`);
      return { success: true };
    } else {
      // Regular characters - use buffer/paste method like custom messages
      // Pipe character via stdin to completely avoid shell escaping
      return new Promise((resolve, reject) => {
        const proc = spawn('bash', ['-c', 'cat | tmux load-buffer -t "$1" - && tmux paste-buffer -t "$1"', '--', session]);

        let stderr = '';

        proc.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        proc.on('close', (code) => {
          if (code !== 0) {
            const error = new Error(`Failed to send key: ${stderr || 'Unknown error'}`);
            console.error(`[Tmux] Failed to send key: ${error.message}`);
            reject(error);
          } else {
            console.log(`[Tmux] Sent key ${key} to session ${session}`);
            resolve({ success: true });
          }
        });

        proc.on('error', (err) => {
          console.error(`[Tmux] Failed to send key: ${err.message}`);
          reject(err);
        });

        // Write character to stdin and close
        proc.stdin.write(key);
        proc.stdin.end();
      });
    }
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
 * Clear tmux scrollback history (keeps last 1000 lines for context)
 * @param {string} session - Tmux session name (default: 'claude')
 * @returns {Promise<object>} Success status
 */
async function clearHistory(session = 'claude') {
  try {
    // Strategy: Set history limit to 1000, then clear, then restore
    // This keeps the last 1000 lines visible and clears older scrollback

    // Get current history limit
    const { stdout: currentLimit } = await execAsync(`tmux show-options -t "${session}" history-limit 2>/dev/null || echo "50000"`);
    const limit = currentLimit.trim().split(' ').pop() || '50000';

    // Temporarily set history to 1000 lines (keeps recent content)
    await execAsync(`tmux set-option -t "${session}" history-limit 1000`);

    // Small delay to let it take effect
    await new Promise(resolve => setTimeout(resolve, 50));

    // Clear history (now only clears beyond the 1000 line limit)
    await execAsync(`tmux clear-history -t "${session}"`);

    // Restore original history limit
    await execAsync(`tmux set-option -t "${session}" history-limit ${limit}`);

    console.log(`[Tmux] Cleared old scrollback for session ${session} (kept last 1000 lines)`);
    return { success: true };
  } catch (error) {
    console.error(`[Tmux] Failed to clear history: ${error.message}`);
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
      // Start claude with resume and --ide flag (no --project needed, we already cd'd)
      await sendCommand(`claude --resume ${conversationId} --ide`, session);

      console.log(`[Tmux] Restarted Claude in session ${session} with conversation ${conversationId}`);
      return {
        success: true,
        resumed: true,
        conversationId: conversationId,
        note: 'Claude will create a fork - update conversation association after restart'
      };
    } else {
      // Just start Claude normally with IDE connection
      await sendCommand('claude --ide', session);
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
  clearHistory,
  getPaneOutput,
  listSessions,
  sessionExists,
  ensureSession
};