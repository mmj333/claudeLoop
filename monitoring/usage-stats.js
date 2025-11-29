#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const readline = require('readline');
const { createReadStream } = require('fs');

// Configuration
const CONFIG = {
  logDir: path.join(__dirname, '../tmp/claudeLogs'),
  statsFile: path.join(__dirname, '../tmp/claude-usage-stats.json'),
  patterns: {
    // Claude response patterns
    tokenUsage: /Tokens:\s*(\d+)\s*input,\s*(\d+)\s*output/i,
    apiUsage: /Usage:\s*(\d+)\s*requests?\s*today/i,
    rateLimitHit: /rate limit|usage limit|quota exceeded/i,
    errorMessage: /error:|exception:|failed:/i,
    compactOperation: /compact|context reset/i,
    taskComplete: /task complete|finished|done|completed successfully/i,
    
    // Time patterns
    sessionStart: /session start|beginning new session/i,
    sessionEnd: /session end|ending session/i,
    pauseDetected: /pausing|pause detected|usage limit reached/i,
    
    // Activity patterns
    fileEdited: /file.*edited|updated.*file|modified/i,
    fileCreated: /file created|created.*file/i,
    testsRun: /running tests|test results/i,
    docsUpdated: /updated.*\.md|documentation updated/i,
  }
};

// Load existing stats or create new
async function loadStats() {
  try {
    const data = await fs.readFile(CONFIG.statsFile, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    return {
      sessions: [],
      totalStats: {
        totalSessions: 0,
        totalTokensInput: 0,
        totalTokensOutput: 0,
        totalRequests: 0,
        rateLimitHits: 0,
        errors: 0,
        compactOperations: 0,
        tasksCompleted: 0,
        filesEdited: 0,
        filesCreated: 0,
        testsRun: 0,
        docsUpdated: 0,
      },
      dailyStats: {},
      hourlyDistribution: Array(24).fill(0),
      averageSessionDuration: 0,
      peakUsageHours: [],
      lastUpdated: null
    };
  }
}

// Save stats
async function saveStats(stats) {
  stats.lastUpdated = new Date().toISOString();
  await fs.writeFile(CONFIG.statsFile, JSON.stringify(stats, null, 2));
}

// Parse a log file
async function parseLogFile(filePath, stats) {
  const fileStream = createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  const fileName = path.basename(filePath);
  const dateMatch = fileName.match(/claude_(\d{4}-\d{2}-\d{2})/);
  const date = dateMatch ? dateMatch[1] : new Date().toISOString().split('T')[0];
  
  // Initialize daily stats
  if (!stats.dailyStats[date]) {
    stats.dailyStats[date] = {
      sessions: 0,
      tokensInput: 0,
      tokensOutput: 0,
      requests: 0,
      rateLimitHits: 0,
      errors: 0,
      compactOperations: 0,
      tasksCompleted: 0,
      filesEdited: 0,
      filesCreated: 0,
      testsRun: 0,
      docsUpdated: 0,
      activityHours: new Set(),
      sessionStarts: [],
      sessionEnds: []
    };
  }
  
  const dayStats = stats.dailyStats[date];
  let currentSession = null;
  let lineNumber = 0;

  for await (const line of rl) {
    lineNumber++;
    
    // Extract timestamp if present
    const timeMatch = line.match(/\[(\d{2}):(\d{2}):(\d{2})\]/);
    const hour = timeMatch ? parseInt(timeMatch[1]) : null;
    
    if (hour !== null) {
      dayStats.activityHours.add(hour);
      stats.hourlyDistribution[hour]++;
    }
    
    // Check patterns
    const tokenMatch = line.match(CONFIG.patterns.tokenUsage);
    if (tokenMatch) {
      const inputTokens = parseInt(tokenMatch[1]);
      const outputTokens = parseInt(tokenMatch[2]);
      dayStats.tokensInput += inputTokens;
      dayStats.tokensOutput += outputTokens;
      stats.totalStats.totalTokensInput += inputTokens;
      stats.totalStats.totalTokensOutput += outputTokens;
    }
    
    const apiMatch = line.match(CONFIG.patterns.apiUsage);
    if (apiMatch) {
      const requests = parseInt(apiMatch[1]);
      dayStats.requests = Math.max(dayStats.requests, requests);
    }
    
    if (CONFIG.patterns.rateLimitHit.test(line)) {
      dayStats.rateLimitHits++;
      stats.totalStats.rateLimitHits++;
    }
    
    if (CONFIG.patterns.errorMessage.test(line)) {
      dayStats.errors++;
      stats.totalStats.errors++;
    }
    
    if (CONFIG.patterns.compactOperation.test(line)) {
      dayStats.compactOperations++;
      stats.totalStats.compactOperations++;
    }
    
    if (CONFIG.patterns.taskComplete.test(line)) {
      dayStats.tasksCompleted++;
      stats.totalStats.tasksCompleted++;
    }
    
    if (CONFIG.patterns.fileEdited.test(line)) {
      dayStats.filesEdited++;
      stats.totalStats.filesEdited++;
    }
    
    if (CONFIG.patterns.fileCreated.test(line)) {
      dayStats.filesCreated++;
      stats.totalStats.filesCreated++;
    }
    
    if (CONFIG.patterns.testsRun.test(line)) {
      dayStats.testsRun++;
      stats.totalStats.testsRun++;
    }
    
    if (CONFIG.patterns.docsUpdated.test(line)) {
      dayStats.docsUpdated++;
      stats.totalStats.docsUpdated++;
    }
    
    // Session tracking
    if (CONFIG.patterns.sessionStart.test(line)) {
      currentSession = { start: new Date(), lines: 0 };
      dayStats.sessionStarts.push(new Date());
      dayStats.sessions++;
      stats.totalStats.totalSessions++;
    }
    
    if (CONFIG.patterns.sessionEnd.test(line) && currentSession) {
      currentSession.end = new Date();
      currentSession.duration = currentSession.end - currentSession.start;
      stats.sessions.push(currentSession);
      dayStats.sessionEnds.push(new Date());
      currentSession = null;
    }
    
    if (currentSession) {
      currentSession.lines++;
    }
  }
  
  // Update total requests
  stats.totalStats.totalRequests += dayStats.requests;
  
  return stats;
}

// Calculate derived statistics
function calculateDerivedStats(stats) {
  // Average session duration
  const validSessions = stats.sessions.filter(s => s.duration && s.duration > 0);
  if (validSessions.length > 0) {
    const totalDuration = validSessions.reduce((sum, s) => sum + s.duration, 0);
    stats.averageSessionDuration = Math.floor(totalDuration / validSessions.length / 1000 / 60); // minutes
  }
  
  // Peak usage hours
  const hourlyActivity = stats.hourlyDistribution
    .map((count, hour) => ({ hour, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  
  stats.peakUsageHours = hourlyActivity.map(h => ({
    hour: h.hour,
    count: h.count,
    percentage: ((h.count / stats.hourlyDistribution.reduce((a, b) => a + b, 1)) * 100).toFixed(1)
  }));
  
  // Daily averages
  const days = Object.keys(stats.dailyStats).length || 1;
  stats.dailyAverages = {
    tokensPerDay: Math.floor(stats.totalStats.totalTokensInput / days),
    requestsPerDay: Math.floor(stats.totalStats.totalRequests / days),
    tasksPerDay: Math.floor(stats.totalStats.tasksCompleted / days),
    filesPerDay: Math.floor((stats.totalStats.filesEdited + stats.totalStats.filesCreated) / days)
  };
  
  return stats;
}

// Generate report
function generateReport(stats) {
  const report = [];
  
  report.push('🤖 Claude Usage Statistics Report');
  report.push('=' .repeat(50));
  report.push('');
  
  // Overall stats
  report.push('📊 Overall Statistics:');
  report.push(`  • Total Sessions: ${stats.totalStats.totalSessions}`);
  report.push(`  • Total Input Tokens: ${stats.totalStats.totalTokensInput.toLocaleString()}`);
  report.push(`  • Total Output Tokens: ${stats.totalStats.totalTokensOutput.toLocaleString()}`);
  report.push(`  • Total Requests: ${stats.totalStats.totalRequests}`);
  report.push(`  • Rate Limit Hits: ${stats.totalStats.rateLimitHits}`);
  report.push(`  • Errors Encountered: ${stats.totalStats.errors}`);
  report.push('');
  
  // Activity stats
  report.push('💼 Activity Summary:');
  report.push(`  • Tasks Completed: ${stats.totalStats.tasksCompleted}`);
  report.push(`  • Files Edited: ${stats.totalStats.filesEdited}`);
  report.push(`  • Files Created: ${stats.totalStats.filesCreated}`);
  report.push(`  • Tests Run: ${stats.totalStats.testsRun}`);
  report.push(`  • Docs Updated: ${stats.totalStats.docsUpdated}`);
  report.push(`  • Compact Operations: ${stats.totalStats.compactOperations}`);
  report.push('');
  
  // Daily averages
  if (stats.dailyAverages) {
    report.push('📅 Daily Averages:');
    report.push(`  • Tokens per Day: ${stats.dailyAverages.tokensPerDay.toLocaleString()}`);
    report.push(`  • Requests per Day: ${stats.dailyAverages.requestsPerDay}`);
    report.push(`  • Tasks per Day: ${stats.dailyAverages.tasksPerDay}`);
    report.push(`  • Files Modified per Day: ${stats.dailyAverages.filesPerDay}`);
    report.push('');
  }
  
  // Session info
  report.push('⏱️ Session Information:');
  report.push(`  • Average Session Duration: ${stats.averageSessionDuration} minutes`);
  report.push('');
  
  // Peak hours
  if (stats.peakUsageHours.length > 0) {
    report.push('🕐 Peak Usage Hours:');
    stats.peakUsageHours.forEach((h, i) => {
      const hourStr = `${h.hour}:00-${h.hour + 1}:00`;
      report.push(`  ${i + 1}. ${hourStr.padEnd(12)} - ${h.count} activities (${h.percentage}%)`);
    });
    report.push('');
  }
  
  // Recent daily stats
  const recentDays = Object.entries(stats.dailyStats)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 7);
  
  if (recentDays.length > 0) {
    report.push('📈 Recent Daily Activity:');
    recentDays.forEach(([date, day]) => {
      report.push(`  ${date}:`);
      report.push(`    • Tokens: ${day.tokensInput + day.tokensOutput} (${day.tokensInput}↓ ${day.tokensOutput}↑)`);
      report.push(`    • Tasks: ${day.tasksCompleted}, Files: ${day.filesEdited + day.filesCreated}`);
      report.push(`    • Active Hours: ${day.activityHours.size}`);
    });
    report.push('');
  }
  
  // Insights
  report.push('💡 Insights:');
  
  if (stats.totalStats.rateLimitHits > 0) {
    report.push(`  ⚠️  Hit rate limits ${stats.totalStats.rateLimitHits} times - consider pacing`);
  }
  
  if (stats.totalStats.errors > 10) {
    report.push(`  ⚠️  ${stats.totalStats.errors} errors detected - review logs for issues`);
  }
  
  const tokenRatio = stats.totalStats.totalTokensOutput / (stats.totalStats.totalTokensInput || 1);
  if (tokenRatio > 2) {
    report.push(`  📝 High output ratio (${tokenRatio.toFixed(1)}:1) - Claude is being verbose`);
  }
  
  if (stats.peakUsageHours[0]?.hour >= 22 || stats.peakUsageHours[0]?.hour <= 4) {
    report.push(`  🌙 Peak usage during late night hours - consider scheduling`);
  }
  
  report.push('');
  report.push(`Last Updated: ${new Date(stats.lastUpdated).toLocaleString()}`);
  
  return report.join('\n');
}

// Main function
async function main() {
  console.log('📊 Analyzing Claude Usage Statistics...\n');
  
  try {
    // Load existing stats
    let stats = await loadStats();
    
    // Get all log files
    const files = await fs.readdir(CONFIG.logDir);
    const logFiles = files
      .filter(f => f.includes('claude') && f.endsWith('.txt'))
      .sort();
    
    console.log(`Found ${logFiles.length} log files to analyze\n`);
    
    // Parse each log file
    for (const file of logFiles) {
      process.stdout.write(`Analyzing ${file}...`);
      const filePath = path.join(CONFIG.logDir, file);
      stats = await parseLogFile(filePath, stats);
      console.log(' ✓');
    }
    
    // Calculate derived statistics
    stats = calculateDerivedStats(stats);
    
    // Save updated stats
    await saveStats(stats);
    
    // Generate and display report
    console.log('\n' + generateReport(stats));
    
    // Save report
    const reportPath = path.join(CONFIG.logDir, 'usage-report.txt');
    await fs.writeFile(reportPath, generateReport(stats));
    console.log(`\n📄 Report saved to: ${reportPath}`);
    
    // Export CSV for further analysis
    const csvPath = path.join(CONFIG.logDir, 'usage-stats.csv');
    const csv = [
      'Date,Sessions,Tokens Input,Tokens Output,Tasks,Files,Errors',
      ...Object.entries(stats.dailyStats).map(([date, day]) => 
        `${date},${day.sessions},${day.tokensInput},${day.tokensOutput},${day.tasksCompleted},${day.filesEdited + day.filesCreated},${day.errors}`
      )
    ].join('\n');
    
    await fs.writeFile(csvPath, csv);
    console.log(`📊 CSV data exported to: ${csvPath}`);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { loadStats, parseLogFile, calculateDerivedStats };