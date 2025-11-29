#!/usr/bin/env node

/**
 * Configuration Utilities - Simplified Version
 * Single source of truth: loop-config-{session}.json files
 */

const fs = require('fs').promises;
const path = require('path');

/**
 * Get session configuration - everything is now in one place
 * 
 * @param {string} session - Session name (e.g., 'claude', 'claude-loop1')
 * @param {object} options - Options object
 * @param {object} options.loopConfig - Default loop config to merge with
 * @returns {object} Complete configuration including conversationId and workingDirectory
 */
async function getSessionConfig(session, { loopConfig = {} } = {}) {
  let config = { ...loopConfig }; // Start with defaults
  
  // Load session-specific config file which now contains everything
  if (session) {
    const sessionConfigFile = path.join(__dirname, `loop-config-${session}.json`);
    try {
      const data = await fs.readFile(sessionConfigFile, 'utf-8');
      const sessionConfig = JSON.parse(data);
      // Merge everything from session config
      config = { ...config, ...sessionConfig };
    } catch (e) {
      // No session config exists, create one with defaults
      console.log(`No config file for ${session}, creating with defaults`);
      try {
        await fs.writeFile(sessionConfigFile, JSON.stringify(config, null, 2));
        console.log(`Created default config for ${session}`);
      } catch (writeErr) {
        console.error(`Failed to create default config for ${session}:`, writeErr);
      }
    }
  }
  
  return config;
}

/**
 * Save session configuration - everything goes to one place now
 * 
 * @param {string} session - Session name
 * @param {object} config - Configuration to save (including conversationId, workingDirectory)
 * @returns {Promise<void>}
 */
async function saveSessionConfig(session, config) {
  if (!session) {
    throw new Error('Session name is required');
  }
  
  const sessionConfigFile = path.join(__dirname, `loop-config-${session}.json`);
  
  // Load existing config first to preserve any fields not being updated
  let existingConfig = {};
  try {
    const data = await fs.readFile(sessionConfigFile, 'utf8');
    existingConfig = JSON.parse(data);
  } catch (e) {
    // File doesn't exist yet, that's ok
  }
  
  // Merge new config with existing, preserving all fields
  const updatedConfig = {
    ...existingConfig,
    ...config,
    lastModified: new Date().toISOString()
  };
  
  // Save the complete config
  await fs.writeFile(sessionConfigFile, JSON.stringify(updatedConfig, null, 2));
  
  return updatedConfig;
}

module.exports = {
  getSessionConfig,
  saveSessionConfig
};