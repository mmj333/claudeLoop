#!/usr/bin/env node

/*
 * Fix config structure - remove duplicates and flatten
 */

const fs = require('fs').promises;
const path = require('path');
const glob = require('glob').sync;

async function fixConfigFile(filePath) {
  try {
    const data = await fs.readFile(filePath, 'utf8');
    const config = JSON.parse(data);
    
    // If there's a nested config object, merge it up
    if (config.config) {
      // Move schedule from nested config to top level (if it exists there)
      if (config.config.schedule) {
        // Keep the full schedule with 1440-element array
        config.schedule = config.config.schedule;
      }
      
      // Remove the nested config object
      delete config.config;
    }
    
    // Remove my "simplified" schedule if it exists alongside the real one
    if (config.schedule && config.schedule.interval && config.schedule.minutes) {
      // We have both - keep the one with minutes array
      delete config.schedule.interval;
    }
    
    // Ensure we have the conversation tracking fields
    // (these were added by migration and should stay)
    // conversationId, workingDirectory, lastModified are all good
    
    // Save the cleaned config
    await fs.writeFile(filePath, JSON.stringify(config, null, 2));
    console.log(`✓ Fixed ${path.basename(filePath)}`);
    
    // Return stats
    return {
      file: path.basename(filePath),
      hasSchedule: !!config.schedule,
      scheduleMinutes: config.schedule?.minutes?.length || 0,
      hasConversationId: !!config.conversationId,
      hasWorkingDirectory: !!config.workingDirectory
    };
    
  } catch (err) {
    console.error(`✗ Failed to fix ${path.basename(filePath)}:`, err.message);
    return null;
  }
}

async function main() {
  console.log('Fixing config file structure...\n');
  
  // Find all loop-config files
  const configFiles = glob(path.join(__dirname, 'loop-config-*.json'));
  
  console.log(`Found ${configFiles.length} config files to fix\n`);
  
  const results = [];
  for (const file of configFiles) {
    const result = await fixConfigFile(file);
    if (result) results.push(result);
  }
  
  // Summary
  console.log('\n=== Summary ===');
  console.log(`Fixed ${results.length} files`);
  
  const withSchedule = results.filter(r => r.hasSchedule);
  console.log(`Files with schedule: ${withSchedule.length}`);
  
  const withFullSchedule = results.filter(r => r.scheduleMinutes === 1440);
  console.log(`Files with full 1440-minute schedule: ${withFullSchedule.length}`);
  
  const withConversation = results.filter(r => r.hasConversationId);
  console.log(`Files with conversationId: ${withConversation.length}`);
  
  const withWorkingDir = results.filter(r => r.hasWorkingDirectory);
  console.log(`Files with workingDirectory: ${withWorkingDir.length}`);
  
  console.log('\nConfig structure fixed!');
}

// Run
if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { fixConfigFile };