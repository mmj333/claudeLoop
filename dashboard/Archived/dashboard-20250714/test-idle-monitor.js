#!/usr/bin/env node

/*
 * Test script for idle-aware Claude loop monitor
 * This script will:
 * 1. Start the monitor in test mode
 * 2. Show real-time status updates
 * 3. Simulate activity/inactivity
 * 4. Display mode transitions
 */

const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');

const IDLE_STATE_FILE = '/tmp/claude_loop_idle_state.json';
const SESSION_NAME = process.argv[2] || 'claude-loop1';

console.log('🧪 Claude Loop Idle Monitor Test\n');
console.log('This test will:');
console.log('1. Start the monitor');
console.log('2. Show idle state changes');
console.log('3. Display refresh intervals');
console.log('4. Simulate pause detection\n');

// Start the monitor
console.log(`📊 Starting monitor for session: ${SESSION_NAME}`);
const monitor = spawn('node', [
  path.join(__dirname, 'claude-loop-monitor-idle-aware.js')
], {
  env: { ...process.env, SESSION_NAME },
  stdio: ['ignore', 'pipe', 'pipe']
});

// Display monitor output
monitor.stdout.on('data', (data) => {
  const output = data.toString();
  // Highlight mode changes and important events
  if (output.includes('Switched to') || output.includes('interval')) {
    console.log(`\n✨ ${output.trim()}`);
  } else if (output.includes('Updated log')) {
    console.log(`📝 ${output.trim()}`);
  } else {
    process.stdout.write(output);
  }
});

monitor.stderr.on('data', (data) => {
  console.error(`❌ Error: ${data}`);
});

// Watch idle state file
let lastIdleState = null;
const watchIdleState = async () => {
  try {
    const stateData = await fs.readFile(IDLE_STATE_FILE, 'utf-8');
    const state = JSON.parse(stateData);
    
    if (!lastIdleState || 
        state.idleLevel !== lastIdleState.idleLevel ||
        state.cpuHistory.length !== lastIdleState.cpuHistory.length) {
      
      const stateNames = ['🟢 Active', '🟡 Idle', '🔴 Very Idle'];
      const avgCpu = state.cpuHistory.length > 0 
        ? (state.cpuHistory.reduce((a, b) => a + b, 0) / state.cpuHistory.length * 100).toFixed(1)
        : 0;
      
      console.log('\n📊 Idle State Update:');
      console.log(`   Mode: ${stateNames[state.idleLevel]}`);
      console.log(`   CPU Usage: ${avgCpu}%`);
      console.log(`   Time since activity: ${Math.floor((Date.now() - state.lastActivityTime) / 60000)} minutes`);
      
      lastIdleState = state;
    }
  } catch (error) {
    // File doesn't exist yet
  }
};

// Poll idle state every 2 seconds
const stateInterval = setInterval(watchIdleState, 2000);

// Test scenarios
console.log('\n🎬 Running test scenarios...\n');

setTimeout(() => {
  console.log('\n📋 Test 1: Monitor should be in ACTIVE mode (1s refresh)');
  console.log('   Watch for "Updated log" messages every ~1 second\n');
}, 3000);

setTimeout(() => {
  console.log('\n📋 Test 2: Waiting for IDLE transition...');
  console.log('   After 2 minutes of no tmux activity, should switch to IDLE mode (5s refresh)');
  console.log('   (You can speed this up by not typing in the tmux session)\n');
}, 10000);

setTimeout(() => {
  console.log('\n📋 Test 3: To test pause detection:');
  console.log('   1. In your tmux session, type: "You\'ve reached Claude\'s usage limit. Try again at 3:00 pm"');
  console.log('   2. Type it again to trigger the double-match requirement');
  console.log('   3. Monitor should detect and create pause files\n');
}, 20000);

// Cleanup on exit
const cleanup = () => {
  console.log('\n🧹 Cleaning up...');
  clearInterval(stateInterval);
  monitor.kill();
  process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Show instructions
console.log('ℹ️  Instructions:');
console.log('   - Keep this running to see mode transitions');
console.log('   - Activity in tmux will reset to ACTIVE mode');
console.log('   - No activity for 2 min → IDLE mode');
console.log('   - No activity for 6 min → VERY IDLE mode');
console.log('   - Press Ctrl+C to stop the test\n');

// Keep the test running
setTimeout(() => {
  console.log('\n✅ Basic tests complete. Monitor is running.');
  console.log('   Continue observing for idle transitions...');
  console.log('   Press Ctrl+C when done.\n');
}, 30000);