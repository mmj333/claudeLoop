#!/usr/bin/env node

/*
 * Migration script to consolidate session-map.json into individual config files
 * This creates a single source of truth for each session
 */

const fs = require('fs').promises;
const path = require('path');

async function migrateSessionMap() {
  console.log('Starting session-map migration...');
  
  const sessionMapPath = path.join(__dirname, 'session-map.json');
  const backupPath = path.join(__dirname, 'session-map.json.backup');
  
  try {
    // Read session-map.json
    const sessionMapData = await fs.readFile(sessionMapPath, 'utf8');
    const sessionMap = JSON.parse(sessionMapData);
    
    // Create backup
    await fs.writeFile(backupPath, sessionMapData);
    console.log(`Created backup at ${backupPath}`);
    
    // Process each session
    for (const [sessionName, sessionData] of Object.entries(sessionMap)) {
      const configPath = path.join(__dirname, `loop-config-${sessionName}.json`);
      
      try {
        // Read existing config if it exists
        let config = {};
        try {
          const configData = await fs.readFile(configPath, 'utf8');
          config = JSON.parse(configData);
        } catch (err) {
          // Config doesn't exist yet, that's ok
          console.log(`No existing config for ${sessionName}, creating new one`);
        }
        
        // Merge session data into config
        // Use workingDirectory consistently (convert projectPath if needed)
        const workingDirectory = sessionData.workingDirectory || sessionData.projectPath;
        
        config = {
          ...config,
          conversationId: sessionData.conversationId,
          workingDirectory: workingDirectory,
          conversationTitle: sessionData.title || config.conversationTitle,
          lastModified: sessionData.setAt || sessionData.trackedAt || new Date().toISOString(),
          manual: sessionData.manual !== undefined ? sessionData.manual : true
        };
        
        // If schedule exists as massive array, simplify it
        if (config.schedule && config.schedule.minutes && Array.isArray(config.schedule.minutes)) {
          const minuteArray = config.schedule.minutes;
          
          // Detect interval pattern (all true = every minute, pattern = interval)
          let interval = 1; // default to every minute
          if (minuteArray.length > 60) {
            // Check if there's a pattern (e.g., every 15 minutes)
            for (let i = 1; i <= 60; i++) {
              let hasPattern = true;
              for (let j = 0; j < minuteArray.length; j += i) {
                if (!minuteArray[j]) {
                  hasPattern = false;
                  break;
                }
              }
              if (hasPattern && i > interval) {
                interval = i;
              }
            }
          }
          
          config.schedule = {
            enabled: config.schedule.enabled !== false,
            interval: config.schedule.precision || interval,
            timezone: config.schedule.timezone || 'America/New_York'
          };
        }
        
        // Clean up undefined values
        Object.keys(config).forEach(key => {
          if (config[key] === undefined) {
            delete config[key];
          }
        });
        
        // Save updated config
        await fs.writeFile(configPath, JSON.stringify(config, null, 2));
        console.log(`✓ Migrated ${sessionName} to ${configPath}`);
        
      } catch (err) {
        console.error(`✗ Failed to migrate ${sessionName}:`, err.message);
      }
    }
    
    console.log('\nMigration complete!');
    console.log('Session-map.json has been backed up but NOT deleted.');
    console.log('After verifying the migration, you can manually delete session-map.json');
    
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

// Run migration
if (require.main === module) {
  migrateSessionMap().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { migrateSessionMap };