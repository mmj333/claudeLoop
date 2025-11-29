#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const { watch } = require('fs');

// Configuration
const CONFIG = {
  logDir: path.join(__dirname, '../tmp/claudeLogs'),
  statsFile: path.join(__dirname, '../tmp/claude-realtime-stats.json'),
  updateInterval: 10000, // 10 seconds
  maxSessionDuration: 8 * 60 * 60 * 1000, // 8 hours
};

// Initialize stats
const stats = {
  currentSession: {
    startTime: new Date(),
    lastActivity: new Date(),
    tokensInput: 0,
    tokensOutput: 0,
    requestCount: 0,
    filesEdited: 0,
    filesCreated: 0,
    errors: 0,
    tasksCompleted: 0,
    rateLimitHits: 0,
  },
  todayStats: {
    date: new Date().toISOString().split('T')[0],
    sessions: 1,
    totalTokensInput: 0,
    totalTokensOutput: 0,
    totalRequests: 0,
    totalErrors: 0,
    totalTasks: 0,
    totalFiles: 0,
    rateLimitHits: 0,
    peakTokensPerMinute: 0,
    activeMinutes: 0,
  },
  realtimeMetrics: {
    tokensPerMinute: 0,
    requestsPerMinute: 0,
    errorRate: 0,
    avgResponseTime: 0,
    isActive: true,
    isPaused: false,
    lastUpdate: new Date(),
  }
};

// Track recent activities for rate calculations
const recentActivities = {
  tokens: [], // { timestamp, count }
  requests: [], // { timestamp }
  errors: [], // { timestamp }
};

// Clean old activities (older than 1 minute)
function cleanRecentActivities() {
  const oneMinuteAgo = Date.now() - 60000;
  
  recentActivities.tokens = recentActivities.tokens.filter(t => t.timestamp > oneMinuteAgo);
  recentActivities.requests = recentActivities.requests.filter(r => r.timestamp > oneMinuteAgo);
  recentActivities.errors = recentActivities.errors.filter(e => e.timestamp > oneMinuteAgo);
}

// Calculate real-time metrics
function calculateRealtimeMetrics() {
  cleanRecentActivities();
  
  // Tokens per minute
  stats.realtimeMetrics.tokensPerMinute = recentActivities.tokens
    .reduce((sum, t) => sum + t.count, 0);
  
  // Requests per minute
  stats.realtimeMetrics.requestsPerMinute = recentActivities.requests.length;
  
  // Error rate (errors per 100 requests)
  const recentRequestCount = recentActivities.requests.length || 1;
  stats.realtimeMetrics.errorRate = (recentActivities.errors.length / recentRequestCount * 100).toFixed(1);
  
  // Update peak tokens per minute
  if (stats.realtimeMetrics.tokensPerMinute > stats.todayStats.peakTokensPerMinute) {
    stats.todayStats.peakTokensPerMinute = stats.realtimeMetrics.tokensPerMinute;
  }
  
  // Check if session is still active
  const timeSinceLastActivity = Date.now() - stats.currentSession.lastActivity;
  stats.realtimeMetrics.isActive = timeSinceLastActivity < 300000; // 5 minutes
  
  // Check if paused (likely hit rate limit)
  stats.realtimeMetrics.isPaused = stats.currentSession.rateLimitHits > 0 && 
                                   timeSinceLastActivity > 60000; // 1 minute
  
  stats.realtimeMetrics.lastUpdate = new Date();
}

// Parse log line for statistics
function parseLogLine(line) {
  const updates = {};
  
  // Token usage pattern
  const tokenMatch = line.match(/Tokens:\s*(\d+)\s*input,\s*(\d+)\s*output/i);
  if (tokenMatch) {
    const inputTokens = parseInt(tokenMatch[1]);
    const outputTokens = parseInt(tokenMatch[2]);
    
    stats.currentSession.tokensInput += inputTokens;
    stats.currentSession.tokensOutput += outputTokens;
    stats.todayStats.totalTokensInput += inputTokens;
    stats.todayStats.totalTokensOutput += outputTokens;
    
    recentActivities.tokens.push({
      timestamp: Date.now(),
      count: inputTokens + outputTokens
    });
    
    updates.tokens = { input: inputTokens, output: outputTokens };
  }
  
  // API request detection
  if (line.includes('API call') || line.includes('Request to') || line.includes('POST /')) {
    stats.currentSession.requestCount++;
    stats.todayStats.totalRequests++;
    recentActivities.requests.push({ timestamp: Date.now() });
    updates.request = true;
  }
  
  // Error detection
  if (/error:|exception:|failed:/i.test(line)) {
    stats.currentSession.errors++;
    stats.todayStats.totalErrors++;
    recentActivities.errors.push({ timestamp: Date.now() });
    updates.error = true;
  }
  
  // Rate limit detection
  if (/rate limit|usage limit|quota exceeded/i.test(line)) {
    stats.currentSession.rateLimitHits++;
    stats.todayStats.rateLimitHits++;
    updates.rateLimit = true;
  }
  
  // File operations
  if (/file.*created|created.*file/i.test(line)) {
    stats.currentSession.filesCreated++;
    stats.todayStats.totalFiles++;
    updates.fileCreated = true;
  }
  
  if (/file.*edited|updated.*file|modified/i.test(line)) {
    stats.currentSession.filesEdited++;
    stats.todayStats.totalFiles++;
    updates.fileEdited = true;
  }
  
  // Task completion
  if (/task complete|finished|done|completed successfully/i.test(line)) {
    stats.currentSession.tasksCompleted++;
    stats.todayStats.totalTasks++;
    updates.taskCompleted = true;
  }
  
  // Update last activity
  if (Object.keys(updates).length > 0) {
    stats.currentSession.lastActivity = new Date();
    stats.todayStats.activeMinutes = Math.floor(
      (Date.now() - stats.currentSession.startTime) / 60000
    );
  }
  
  return updates;
}

// Save stats to file
async function saveStats() {
  calculateRealtimeMetrics();
  
  const output = {
    ...stats,
    summary: {
      sessionDuration: Math.floor((Date.now() - stats.currentSession.startTime) / 60000) + ' minutes',
      productivity: {
        tasksPerHour: (stats.currentSession.tasksCompleted / (stats.todayStats.activeMinutes / 60)).toFixed(1),
        filesPerHour: ((stats.currentSession.filesCreated + stats.currentSession.filesEdited) / (stats.todayStats.activeMinutes / 60)).toFixed(1),
      },
      efficiency: {
        tokenEfficiency: stats.currentSession.tokensInput > 0 ? 
          (stats.currentSession.tokensOutput / stats.currentSession.tokensInput).toFixed(2) : 0,
        errorRate: stats.currentSession.requestCount > 0 ?
          (stats.currentSession.errors / stats.currentSession.requestCount * 100).toFixed(1) + '%' : '0%',
      }
    }
  };
  
  await fs.writeFile(CONFIG.statsFile, JSON.stringify(output, null, 2));
}

// Watch current log file
async function watchLogFile() {
  const currentLogPath = path.join(CONFIG.logDir, `claude_${new Date().toISOString().split('T')[0]}_current.txt`);
  
  let lastSize = 0;
  try {
    const stats = await fs.stat(currentLogPath);
    lastSize = stats.size;
  } catch (error) {
    console.log('⏳ Waiting for log file to be created...');
  }
  
  // Watch for changes
  const watcher = watch(currentLogPath, async (eventType) => {
    if (eventType === 'change') {
      try {
        const stats = await fs.stat(currentLogPath);
        if (stats.size > lastSize) {
          // Read new content
          const fd = await fs.open(currentLogPath, 'r');
          const buffer = Buffer.alloc(stats.size - lastSize);
          await fd.read(buffer, 0, buffer.length, lastSize);
          await fd.close();
          
          const newContent = buffer.toString('utf-8');
          const lines = newContent.split('\n').filter(line => line.trim());
          
          // Parse each new line
          for (const line of lines) {
            const updates = parseLogLine(line);
            if (Object.keys(updates).length > 0) {
              console.log('📊 Update:', updates);
            }
          }
          
          lastSize = stats.size;
          
          // Save updated stats
          await saveStats();
        }
      } catch (error) {
        // File might be rotating
      }
    }
  });
  
  return watcher;
}

// Display current stats
function displayStats() {
  console.clear();
  console.log('🤖 Claude Real-Time Statistics Tracker');
  console.log('=' .repeat(50));
  console.log('');
  
  // Session info
  const sessionMinutes = Math.floor((Date.now() - stats.currentSession.startTime) / 60000);
  console.log(`📅 Session: ${sessionMinutes} minutes | Status: ${
    stats.realtimeMetrics.isPaused ? '⏸️  Paused' : 
    stats.realtimeMetrics.isActive ? '🟢 Active' : '🟡 Idle'
  }`);
  console.log('');
  
  // Current session stats
  console.log('📊 Current Session:');
  console.log(`  Tokens: ${stats.currentSession.tokensInput + stats.currentSession.tokensOutput} (${stats.currentSession.tokensInput}↓ ${stats.currentSession.tokensOutput}↑)`);
  console.log(`  Requests: ${stats.currentSession.requestCount} | Errors: ${stats.currentSession.errors}`);
  console.log(`  Tasks: ${stats.currentSession.tasksCompleted} | Files: ${stats.currentSession.filesCreated + stats.currentSession.filesEdited}`);
  if (stats.currentSession.rateLimitHits > 0) {
    console.log(`  ⚠️  Rate Limits Hit: ${stats.currentSession.rateLimitHits}`);
  }
  console.log('');
  
  // Real-time metrics
  console.log('⚡ Real-Time Metrics:');
  console.log(`  Tokens/min: ${stats.realtimeMetrics.tokensPerMinute}`);
  console.log(`  Requests/min: ${stats.realtimeMetrics.requestsPerMinute}`);
  console.log(`  Error Rate: ${stats.realtimeMetrics.errorRate}%`);
  console.log('');
  
  // Today's totals
  console.log('📈 Today\'s Totals:');
  console.log(`  Total Tokens: ${stats.todayStats.totalTokensInput + stats.todayStats.totalTokensOutput}`);
  console.log(`  Total Requests: ${stats.todayStats.totalRequests}`);
  console.log(`  Total Tasks: ${stats.todayStats.totalTasks}`);
  console.log(`  Peak Tokens/min: ${stats.todayStats.peakTokensPerMinute}`);
  console.log('');
  
  // Productivity metrics
  const tasksPerHour = sessionMinutes > 0 ? 
    (stats.currentSession.tasksCompleted / (sessionMinutes / 60)).toFixed(1) : 0;
  const filesPerHour = sessionMinutes > 0 ?
    ((stats.currentSession.filesCreated + stats.currentSession.filesEdited) / (sessionMinutes / 60)).toFixed(1) : 0;
  
  console.log('💪 Productivity:');
  console.log(`  Tasks/hour: ${tasksPerHour}`);
  console.log(`  Files/hour: ${filesPerHour}`);
  console.log('');
  
  console.log(`Last Update: ${new Date().toLocaleTimeString()}`);
  console.log('');
  console.log('Press Ctrl+C to stop tracking');
}

// Main function
async function main() {
  console.log('🚀 Starting Claude Real-Time Statistics Tracker...\n');
  
  // Create directories if needed
  await fs.mkdir(CONFIG.logDir, { recursive: true });
  
  // Start watching log file
  const watcher = await watchLogFile();
  
  // Update display periodically
  const displayInterval = setInterval(() => {
    displayStats();
  }, 5000);
  
  // Save stats periodically
  const saveInterval = setInterval(() => {
    saveStats();
  }, CONFIG.updateInterval);
  
  // Initial display
  displayStats();
  
  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log('\n\n📊 Saving final statistics...');
    await saveStats();
    
    watcher.close();
    clearInterval(displayInterval);
    clearInterval(saveInterval);
    
    console.log('✅ Statistics saved to:', CONFIG.statsFile);
    process.exit(0);
  });
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { parseLogLine, calculateRealtimeMetrics };