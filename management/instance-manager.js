#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const { spawn, execSync } = require('child_process');
const readline = require('readline');

// Configuration
const CONFIG = {
  instancesFile: path.join(__dirname, '../tmp/claude-instances.json'),
  defaultLoopScript: path.join(__dirname, '../tmp/claudeLoop/claude-loop-enhanced-v2.sh'),
  basePort: 3334, // Starting port for instance dashboards
};

// Load instances configuration
async function loadInstances() {
  try {
    const data = await fs.readFile(CONFIG.instancesFile, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    return {
      instances: {},
      nextPort: CONFIG.basePort,
    };
  }
}

// Save instances configuration
async function saveInstances(instances) {
  await fs.writeFile(CONFIG.instancesFile, JSON.stringify(instances, null, 2));
}

// Create new instance
async function createInstance(name, projectPath, config = {}) {
  const instances = await loadInstances();
  
  if (instances.instances[name]) {
    throw new Error(`Instance '${name}' already exists`);
  }
  
  // Validate project path
  try {
    const stats = await fs.stat(projectPath);
    if (!stats.isDirectory()) {
      throw new Error('Project path must be a directory');
    }
  } catch (error) {
    throw new Error(`Invalid project path: ${projectPath}`);
  }
  
  // Create instance configuration
  const instance = {
    name,
    projectPath: path.resolve(projectPath),
    createdAt: new Date().toISOString(),
    config: {
      loopScript: config.loopScript || CONFIG.defaultLoopScript,
      logDir: config.logDir || path.join(projectPath, 'tmp/claudeLogs'),
      sessionDir: config.sessionDir || path.join(projectPath, 'tmp/session_summaries'),
      dashboardPort: instances.nextPort++,
      autoRestart: config.autoRestart || false,
      maxSessionDuration: config.maxSessionDuration || 8, // hours
      pauseOnRateLimit: config.pauseOnRateLimit !== false, // default true
    },
    status: {
      running: false,
      pid: null,
      lastStarted: null,
      lastStopped: null,
      totalSessions: 0,
      totalRuntime: 0, // minutes
    },
    stats: {
      totalTokens: 0,
      totalRequests: 0,
      totalTasks: 0,
      totalErrors: 0,
      rateLimitHits: 0,
    }
  };
  
  instances.instances[name] = instance;
  await saveInstances(instances);
  
  // Create directories
  await fs.mkdir(instance.config.logDir, { recursive: true });
  await fs.mkdir(instance.config.sessionDir, { recursive: true });
  
  console.log(`✅ Created instance '${name}' for project: ${projectPath}`);
  console.log(`   Dashboard will be available at: http://localhost:${instance.config.dashboardPort}`);
  
  return instance;
}

// Start instance
async function startInstance(name) {
  const instances = await loadInstances();
  const instance = instances.instances[name];
  
  if (!instance) {
    throw new Error(`Instance '${name}' not found`);
  }
  
  if (instance.status.running) {
    console.log(`⚠️  Instance '${name}' is already running (PID: ${instance.status.pid})`);
    return;
  }
  
  console.log(`🚀 Starting instance '${name}'...`);
  
  // Change to project directory
  process.chdir(instance.projectPath);
  
  // Start Claude loop
  const loopProcess = spawn('bash', [instance.config.loopScript], {
    cwd: instance.projectPath,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  
  // Update instance status
  instance.status.running = true;
  instance.status.pid = loopProcess.pid;
  instance.status.lastStarted = new Date().toISOString();
  instance.status.totalSessions++;
  
  await saveInstances(instances);
  
  // Start dashboard
  const dashboardProcess = spawn('node', [
    path.join(__dirname, 'claude-loop-dashboard-simple.js')
  ], {
    cwd: instance.projectPath,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: instance.config.dashboardPort,
      LOG_DIR: instance.config.logDir,
      SESSION_DIR: instance.config.sessionDir,
    }
  });
  
  dashboardProcess.unref();
  loopProcess.unref();
  
  console.log(`✅ Instance '${name}' started`);
  console.log(`   PID: ${loopProcess.pid}`);
  console.log(`   Dashboard: http://localhost:${instance.config.dashboardPort}`);
  console.log(`   Logs: ${instance.config.logDir}`);
}

// Stop instance
async function stopInstance(name) {
  const instances = await loadInstances();
  const instance = instances.instances[name];
  
  if (!instance) {
    throw new Error(`Instance '${name}' not found`);
  }
  
  if (!instance.status.running) {
    console.log(`⚠️  Instance '${name}' is not running`);
    return;
  }
  
  console.log(`🛑 Stopping instance '${name}'...`);
  
  try {
    // Kill the Claude loop process
    process.kill(instance.status.pid, 'SIGTERM');
    
    // Update status
    instance.status.running = false;
    instance.status.lastStopped = new Date().toISOString();
    
    // Calculate runtime
    const runtime = Math.floor(
      (new Date(instance.status.lastStopped) - new Date(instance.status.lastStarted)) / 60000
    );
    instance.status.totalRuntime += runtime;
    
    instance.status.pid = null;
    await saveInstances(instances);
    
    console.log(`✅ Instance '${name}' stopped (runtime: ${runtime} minutes)`);
  } catch (error) {
    console.error(`❌ Error stopping instance: ${error.message}`);
  }
}

// List all instances
async function listInstances() {
  const instances = await loadInstances();
  const instanceList = Object.values(instances.instances);
  
  if (instanceList.length === 0) {
    console.log('No instances configured. Use "create" command to add one.');
    return;
  }
  
  console.log('\n🤖 Claude Loop Instances:\n');
  console.log('Name'.padEnd(20) + 'Status'.padEnd(12) + 'Project Path');
  console.log('-'.repeat(70));
  
  for (const instance of instanceList) {
    const status = instance.status.running ? 
      `🟢 Running`.padEnd(12) : 
      `⚫ Stopped`.padEnd(12);
    
    console.log(
      instance.name.padEnd(20) + 
      status + 
      instance.projectPath
    );
    
    if (instance.status.running) {
      console.log(`${''.padEnd(20)}PID: ${instance.status.pid} | Dashboard: http://localhost:${instance.config.dashboardPort}`);
    }
  }
  
  console.log('\n📊 Summary:');
  const running = instanceList.filter(i => i.status.running).length;
  console.log(`  Total instances: ${instanceList.length}`);
  console.log(`  Running: ${running}`);
  console.log(`  Stopped: ${instanceList.length - running}`);
}

// Show instance details
async function showInstance(name) {
  const instances = await loadInstances();
  const instance = instances.instances[name];
  
  if (!instance) {
    throw new Error(`Instance '${name}' not found`);
  }
  
  console.log(`\n🤖 Instance: ${name}`);
  console.log('=' .repeat(50));
  
  console.log('\n📍 Configuration:');
  console.log(`  Project Path: ${instance.projectPath}`);
  console.log(`  Log Directory: ${instance.config.logDir}`);
  console.log(`  Dashboard Port: ${instance.config.dashboardPort}`);
  console.log(`  Auto Restart: ${instance.config.autoRestart}`);
  console.log(`  Max Session Duration: ${instance.config.maxSessionDuration} hours`);
  
  console.log('\n📊 Status:');
  console.log(`  Running: ${instance.status.running ? '🟢 Yes' : '⚫ No'}`);
  if (instance.status.running) {
    console.log(`  PID: ${instance.status.pid}`);
    console.log(`  Dashboard: http://localhost:${instance.config.dashboardPort}`);
  }
  console.log(`  Last Started: ${instance.status.lastStarted || 'Never'}`);
  console.log(`  Last Stopped: ${instance.status.lastStopped || 'Never'}`);
  console.log(`  Total Sessions: ${instance.status.totalSessions}`);
  console.log(`  Total Runtime: ${instance.status.totalRuntime} minutes`);
  
  console.log('\n📈 Statistics:');
  console.log(`  Total Tokens: ${instance.stats.totalTokens}`);
  console.log(`  Total Requests: ${instance.stats.totalRequests}`);
  console.log(`  Total Tasks: ${instance.stats.totalTasks}`);
  console.log(`  Total Errors: ${instance.stats.totalErrors}`);
  console.log(`  Rate Limit Hits: ${instance.stats.rateLimitHits}`);
  
  console.log('\n💡 Commands:');
  console.log(`  Start: claude-instance-manager start ${name}`);
  console.log(`  Stop: claude-instance-manager stop ${name}`);
  console.log(`  Remove: claude-instance-manager remove ${name}`);
}

// Remove instance
async function removeInstance(name) {
  const instances = await loadInstances();
  const instance = instances.instances[name];
  
  if (!instance) {
    throw new Error(`Instance '${name}' not found`);
  }
  
  if (instance.status.running) {
    throw new Error(`Cannot remove running instance. Stop it first.`);
  }
  
  // Confirm removal
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  const answer = await new Promise(resolve => {
    rl.question(`Are you sure you want to remove instance '${name}'? (y/N) `, resolve);
  });
  rl.close();
  
  if (answer.toLowerCase() !== 'y') {
    console.log('Removal cancelled.');
    return;
  }
  
  delete instances.instances[name];
  await saveInstances(instances);
  
  console.log(`✅ Instance '${name}' removed`);
}

// Update instance statistics
async function updateStats(name) {
  const instances = await loadInstances();
  const instance = instances.instances[name];
  
  if (!instance) {
    throw new Error(`Instance '${name}' not found`);
  }
  
  // Load stats from the instance's stats file
  try {
    const statsFile = path.join(instance.projectPath, 'tmp/claude-usage-stats.json');
    const stats = JSON.parse(await fs.readFile(statsFile, 'utf-8'));
    
    instance.stats.totalTokens = stats.totalStats.totalTokensInput + stats.totalStats.totalTokensOutput;
    instance.stats.totalRequests = stats.totalStats.totalRequests;
    instance.stats.totalTasks = stats.totalStats.tasksCompleted;
    instance.stats.totalErrors = stats.totalStats.errors;
    instance.stats.rateLimitHits = stats.totalStats.rateLimitHits;
    
    await saveInstances(instances);
    console.log(`✅ Updated statistics for instance '${name}'`);
  } catch (error) {
    console.log(`⚠️  No statistics available for instance '${name}'`);
  }
}

// Main CLI
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  
  try {
    switch (command) {
      case 'create':
        if (args.length < 3) {
          console.error('Usage: claude-instance-manager create <name> <project-path> [options]');
          process.exit(1);
        }
        await createInstance(args[1], args[2]);
        break;
        
      case 'start':
        if (args.length < 2) {
          console.error('Usage: claude-instance-manager start <name>');
          process.exit(1);
        }
        await startInstance(args[1]);
        break;
        
      case 'stop':
        if (args.length < 2) {
          console.error('Usage: claude-instance-manager stop <name>');
          process.exit(1);
        }
        await stopInstance(args[1]);
        break;
        
      case 'list':
        await listInstances();
        break;
        
      case 'show':
        if (args.length < 2) {
          console.error('Usage: claude-instance-manager show <name>');
          process.exit(1);
        }
        await showInstance(args[1]);
        break;
        
      case 'remove':
        if (args.length < 2) {
          console.error('Usage: claude-instance-manager remove <name>');
          process.exit(1);
        }
        await removeInstance(args[1]);
        break;
        
      case 'update-stats':
        if (args.length < 2) {
          console.error('Usage: claude-instance-manager update-stats <name>');
          process.exit(1);
        }
        await updateStats(args[1]);
        break;
        
      case 'help':
      default:
        console.log(`
🤖 Claude Instance Manager

Usage: claude-instance-manager <command> [options]

Commands:
  create <name> <path>     Create a new Claude loop instance
  start <name>             Start an instance
  stop <name>              Stop a running instance
  list                     List all instances
  show <name>              Show instance details
  remove <name>            Remove an instance (must be stopped)
  update-stats <name>      Update instance statistics
  help                     Show this help message

Examples:
  claude-instance-manager create infiniquest /home/michael/InfiniQuest
  claude-instance-manager start infiniquest
  claude-instance-manager list
  claude-instance-manager stop infiniquest

Each instance runs independently with its own:
  • Claude loop process
  • Log directory
  • Dashboard port
  • Statistics tracking
        `);
        break;
    }
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { createInstance, startInstance, stopInstance, listInstances };