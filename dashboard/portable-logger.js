#!/usr/bin/env node

/**
 * Portable Tiered Logging System
 * Drop this into any Node.js project for instant configurable logging
 * 
 * Usage:
 *   const log = require('./portable-logger')('MY_APP');
 *   log.info('Server started');
 *   
 * Environment variables:
 *   LOG_LEVEL=error|warn|info|debug|verbose
 *   MY_APP_LOG_LEVEL=debug  (app-specific override)
 *   
 * Features:
 *   - Colored output for terminals
 *   - Timestamps
 *   - App prefixes
 *   - File output option
 */

const createLogger = (appName = 'APP', options = {}) => {
  const {
    envVar = `${appName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_LOG_LEVEL`,
    defaultLevel = 'info',
    useColors = process.stdout.isTTY,
    includeTimestamp = false,
    logFile = null
  } = options;

  // Set logging level via app-specific env var, general LOG_LEVEL, or default
  const LOG_LEVEL = process.env[envVar] || process.env.LOG_LEVEL || defaultLevel;

  const LOG_LEVELS = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
    verbose: 4
  };

  const COLORS = {
    error: '\x1b[31m',    // Red
    warn: '\x1b[33m',     // Yellow
    info: '\x1b[36m',     // Cyan
    debug: '\x1b[35m',    // Magenta
    verbose: '\x1b[90m',  // Gray
    reset: '\x1b[0m'
  };

  const currentLogLevel = LOG_LEVELS[LOG_LEVEL.toLowerCase()] ?? LOG_LEVELS.info;

  // Announce log level if not default
  if (currentLogLevel >= LOG_LEVELS.info && LOG_LEVEL !== defaultLevel) {
    console.log(`[${appName}] Logging level: ${LOG_LEVEL}`);
  }

  const formatMessage = (level, args) => {
    const prefix = includeTimestamp 
      ? `[${new Date().toISOString()}] [${appName}:${level.toUpperCase()}]`
      : `[${appName}:${level.toUpperCase()}]`;
    
    if (useColors && COLORS[level]) {
      return [COLORS[level] + prefix + COLORS.reset, ...args];
    }
    return [prefix, ...args];
  };

  const writeToFile = (message) => {
    if (logFile) {
      const fs = require('fs');
      fs.appendFileSync(logFile, message + '\n');
    }
  };

  const logMethod = (level, consoleFn) => (...args) => {
    if (currentLogLevel >= LOG_LEVELS[level]) {
      const formatted = formatMessage(level, args);
      consoleFn(...formatted);
      
      if (logFile) {
        // Strip colors for file output
        const plainMessage = formatted.join(' ').replace(/\x1b\[[0-9;]*m/g, '');
        writeToFile(plainMessage);
      }
    }
  };

  return {
    error: logMethod('error', console.error),
    warn: logMethod('warn', console.warn),
    info: logMethod('info', console.log),
    debug: logMethod('debug', console.log),
    verbose: logMethod('verbose', console.log),
    
    // Utility methods
    getLevel: () => LOG_LEVEL,
    getLevelNumber: () => currentLogLevel,
    isVerbose: () => currentLogLevel >= LOG_LEVELS.verbose,
    isDebug: () => currentLogLevel >= LOG_LEVELS.debug,
    isInfo: () => currentLogLevel >= LOG_LEVELS.info,
    
    // Create child logger with different prefix
    child: (childName) => createLogger(`${appName}:${childName}`, options),
    
    // Conditional logging
    ifDebug: (fn) => currentLogLevel >= LOG_LEVELS.debug && fn(),
    ifVerbose: (fn) => currentLogLevel >= LOG_LEVELS.verbose && fn()
  };
};

// Export factory function
module.exports = createLogger;

// Also export a default instance
module.exports.default = createLogger('APP');

// Example usage when run directly
if (require.main === module) {
  console.log('\n=== Portable Logger Demo ===\n');
  
  // Basic usage
  const log = createLogger('MyApp');
  log.error('This is an error');
  log.warn('This is a warning');
  log.info('This is info');
  log.debug('This is debug');
  log.verbose('This is verbose');
  
  console.log('\n--- With timestamps ---\n');
  const tsLog = createLogger('TimeApp', { includeTimestamp: true });
  tsLog.info('Server started on port 3000');
  
  console.log('\n--- Child loggers ---\n');
  const dbLog = log.child('database');
  dbLog.info('Connected to MongoDB');
  
  const apiLog = log.child('api');
  apiLog.debug('Processing request to /users');
  
  console.log('\n--- Conditional logging ---\n');
  log.ifDebug(() => {
    log.debug('This only runs in debug mode');
  });
  
  console.log('\nCurrent log level:', log.getLevel());
  console.log('Is debug enabled?', log.isDebug());
}