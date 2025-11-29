#!/usr/bin/env node

/**
 * Conversation Auto-Setup
 * Automatically associates and names new conversations after Claude starts
 */

const fs = require('fs').promises;
const path = require('path');
const os = require('os');

/**
 * Wait for a new conversation to appear and set it up
 * @param {string} session - Tmux session name
 * @param {string} workingDir - Working directory where Claude was started
 * @param {object} options - Options for setup
 * @returns {Promise<object>} Result with conversation ID and setup details
 */
async function setupNewConversation(session, workingDir, options = {}) {
  const {
    customName = null,
    sessionMatcher = null,
    conversationNamer = null,
    maxWaitTime = 10000, // Max time to wait for conversation
    checkInterval = 500   // How often to check for new conversation
  } = options;
  
  console.log(`[Auto-Setup] Waiting for new conversation in ${workingDir} for session ${session}...`);
  
  const startTime = Date.now();
  const projectPath = workingDir.replace(/\//g, '-');
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectPath);
  
  // Get list of existing conversations before we start
  let existingFiles = new Set();
  try {
    const files = await fs.readdir(projectDir);
    existingFiles = new Set(files.filter(f => f.endsWith('.jsonl')));
  } catch (e) {
    // Directory might not exist yet
  }
  
  // Poll for new conversation file
  while (Date.now() - startTime < maxWaitTime) {
    try {
      const files = await fs.readdir(projectDir);
      const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
      
      // Find new files that weren't there before
      const newFiles = jsonlFiles.filter(f => !existingFiles.has(f));
      
      if (newFiles.length > 0) {
        // Found a new conversation!
        const newFile = newFiles[0]; // Take the first (should only be one)
        const conversationId = newFile.replace('.jsonl', '');
        
        console.log(`[Auto-Setup] Found new conversation: ${conversationId}`);
        
        // Associate with session
        if (sessionMatcher) {
          await sessionMatcher.setSessionConversation(session, conversationId, workingDir);
          console.log(`[Auto-Setup] Associated conversation ${conversationId} with session ${session}`);
        }
        
        // Set custom name if provided
        if (customName && conversationNamer) {
          await conversationNamer.setName(conversationId, customName);
          console.log(`[Auto-Setup] Named conversation as "${customName}"`);
        }
        
        return {
          success: true,
          conversationId,
          workingDir,
          session,
          customName,
          message: `Auto-setup complete for conversation ${conversationId}`
        };
      }
    } catch (e) {
      // Keep trying
    }
    
    await new Promise(resolve => setTimeout(resolve, checkInterval));
  }
  
  // Timeout - couldn't find new conversation
  console.warn(`[Auto-Setup] Timeout waiting for new conversation in ${workingDir}`);
  return {
    success: false,
    message: 'Timeout waiting for new conversation file'
  };
}

/**
 * Setup conversation after Claude restart with resume
 * Waits for the fork to be created and associates it
 */
async function setupResumedConversation(session, originalConversationId, workingDir, options = {}) {
  console.log(`[Auto-Setup] Waiting for fork of ${originalConversationId}...`);
  
  // When Claude resumes, it creates a fork with a new ID
  // We need to detect this new conversation and associate it
  
  const result = await setupNewConversation(session, workingDir, {
    ...options,
    maxWaitTime: 15000 // Give more time for resume
  });
  
  if (result.success) {
    console.log(`[Auto-Setup] Fork detected: ${result.conversationId} (from ${originalConversationId})`);
    result.parentConversationId = originalConversationId;
    result.isFork = true;
  }
  
  return result;
}

/**
 * Monitor and setup conversations for a session
 * Can be called after starting/restarting Claude
 */
async function monitorAndSetup(session, config = {}) {
  const {
    workingDir = '/home/michael/InfiniQuest',
    customName = null,
    isResume = false,
    originalConversationId = null,
    delay = 2000 // Wait before starting to look for conversation
  } = config;
  
  // Load required modules if available
  let sessionMatcher, conversationNamer;
  try {
    const ClaudeSessionMatcher = require('./claude-session-matcher.js');
    sessionMatcher = new ClaudeSessionMatcher();
    await sessionMatcher.init();
  } catch (e) {
    console.warn('[Auto-Setup] SessionMatcher not available');
  }
  
  try {
    conversationNamer = require('./conversation-names.js');
  } catch (e) {
    console.warn('[Auto-Setup] ConversationNamer not available');
  }
  
  // Wait a bit for Claude to fully start and create conversation
  await new Promise(resolve => setTimeout(resolve, delay));
  
  if (isResume && originalConversationId) {
    return await setupResumedConversation(session, originalConversationId, workingDir, {
      customName,
      sessionMatcher,
      conversationNamer
    });
  } else {
    return await setupNewConversation(session, workingDir, {
      customName,
      sessionMatcher,
      conversationNamer
    });
  }
}

module.exports = {
  setupNewConversation,
  setupResumedConversation,
  monitorAndSetup
};