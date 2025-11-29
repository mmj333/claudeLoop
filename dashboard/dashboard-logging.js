#!/usr/bin/env node

/**
 * Dashboard Logging System
 * Wrapper around the portable logger utility for backward compatibility
 * 
 * This now uses the central portable logger at /home/michael/utilities/portable-logger/
 * Environment variable: DASHBOARD_LOG_LEVEL=error|warn|info|debug|verbose
 */

// Use the portable logger with Dashboard-specific configuration
const createLogger = require('/home/michael/utilities/portable-logger');

// Create logger instance with Dashboard defaults
const log = createLogger('Dashboard', {
  envVar: 'DASHBOARD_LOG_LEVEL',
  defaultLevel: 'info'
});

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = log;
}

// Also make available globally for dashboard HTML if needed
if (typeof window !== 'undefined') {
  window.dashboardLog = log;
}