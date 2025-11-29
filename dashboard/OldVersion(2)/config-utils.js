#!/usr/bin/env node

/**
 * Configuration Utilities
 * Centralized config management for Claude Loop Dashboard
 */

const fs = require('fs').promises;
const path = require('path');

/**
 * Get session configuration with conversation ID merged from session-map.json
 * This is the single source of truth for reading session configs
 * 
 * @param {string} session - Session name (e.g., 'claude', 'claude-loop1')
 * @param {object} options - Options object
 * @param {object} options.loopConfig - Default loop config to merge with
 * @param {object} options.sessionMatcher - Session matcher instance for conversation lookups
 * @returns {object} Complete configuration with conversationId merged
 */
async function getSessionConfig(session, { loopConfig = {}, sessionMatcher = null } = {}) {
  let config = { ...loopConfig }; // Start with defaults
  
  // Try to load session-specific config file
  if (session) {
    const sessionConfigFile = path.join(__dirname, `loop-config-${session}.json`);
    try {
      const data = await fs.readFile(sessionConfigFile, 'utf-8');
      const sessionConfig = JSON.parse(data);
      // Merge session config (but not conversationId if it exists in file)
      const { conversationId, ...sessionConfigWithoutConvId } = sessionConfig;
      config = { ...config, ...sessionConfigWithoutConvId };
    } catch (e) {
      // No session config exists, use defaults
      // This is normal for new sessions
    }
    
    // Add conversationId from session-map.json if it exists (single source of truth)
    if (sessionMatcher) {
      const trackedConv = sessionMatcher.getTrackedConversation(session);
      if (trackedConv && trackedConv.conversationId) {
        config.conversationId = trackedConv.conversationId;
      }
    }
  }
  
  return config;
}

/**
 * Save session configuration (without conversationId - that goes to session-map.json)
 * 
 * @param {string} session - Session name
 * @param {object} config - Configuration to save
 * @returns {Promise<void>}
 */
async function saveSessionConfig(session, config) {
  if (!session) {
    throw new Error('Session name is required');
  }
  
  // Remove conversationId - it should not be saved in config files
  const { conversationId, ...configWithoutConvId } = config;
  
  const sessionConfigFile = path.join(__dirname, `loop-config-${session}.json`);
  await fs.writeFile(sessionConfigFile, JSON.stringify(configWithoutConvId, null, 2));
}

module.exports = {
  getSessionConfig,
  saveSessionConfig
};