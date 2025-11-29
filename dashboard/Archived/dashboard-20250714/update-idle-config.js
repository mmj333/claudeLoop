#!/usr/bin/env node

/*
 * InfiniQuest - Family Productivity Software
 * Copyright (C) 2025 Michael Johnson <wholeness@infiniquest.app>
 *
 * Configuration updater for idle-aware monitor
 */

const fs = require('fs').promises;
const path = require('path');

async function updateIdleConfig(sessionName = 'claude-loop1') {
  const configPath = path.join(__dirname, `loop-config-${sessionName}.json`);
  
  try {
    // Load existing config
    const configData = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(configData);
    
    // Add idle-specific settings if not present
    if (!config.monitorSettings) {
      config.monitorSettings = {};
    }
    
    // Set default idle settings
    config.monitorSettings = {
      ...config.monitorSettings,
      checkIntervalActive: 1, // seconds
      checkIntervalIdle: 5, // seconds
      checkIntervalMaxIdle: 30, // seconds
      idleThresholdMinutes: 2,
      cpuIdleThreshold: 0.10,
      pauseDebounceMinutes: 1
    };
    
    // Keep the original logRefreshRate for backward compatibility
    if (!config.logRefreshRate) {
      config.logRefreshRate = config.monitorSettings.checkIntervalActive;
    }
    
    // Save updated config
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    
    console.log(`✅ Updated config for ${sessionName} with idle settings:`);
    console.log(`   Active interval: ${config.monitorSettings.checkIntervalActive}s`);
    console.log(`   Idle interval: ${config.monitorSettings.checkIntervalIdle}s`);
    console.log(`   Max idle interval: ${config.monitorSettings.checkIntervalMaxIdle}s`);
    console.log(`   Idle threshold: ${config.monitorSettings.idleThresholdMinutes} minutes`);
    console.log(`   CPU idle threshold: ${(config.monitorSettings.cpuIdleThreshold * 100).toFixed(0)}%`);
    
  } catch (error) {
    console.error(`❌ Error updating config: ${error.message}`);
  }
}

// Run if called directly
if (require.main === module) {
  const sessionName = process.argv[2] || 'claude-loop1';
  updateIdleConfig(sessionName);
}

module.exports = { updateIdleConfig };