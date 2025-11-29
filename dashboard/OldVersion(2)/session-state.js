#!/usr/bin/env node

/**
 * Session State Manager
 * Centralized management of the currently selected tmux session
 * Single source of truth for which session is active
 */

class SessionStateManager {
  constructor() {
    this.currentSession = null;
    this.availableSessions = [];
    this.listeners = [];
    this.storageKey = 'claudeLoop.currentSession';
  }

  /**
   * Initialize the session state
   * @param {Array} availableSessions - List of available tmux sessions
   * @returns {string} The current active session
   */
  async initialize(availableSessions = []) {
    this.availableSessions = availableSessions;
    
    // Get stored preference
    const stored = this.getStoredSession();
    
    // Validate stored session still exists
    if (stored && availableSessions.includes(stored)) {
      this.currentSession = stored;
    } else if (availableSessions.length > 0) {
      // Fall back to first available session
      this.currentSession = availableSessions[0];
      this.saveSession();
    } else {
      // No sessions available
      this.currentSession = null;
    }
    
    return this.currentSession;
  }

  /**
   * Get the current session
   * @returns {string|null} Current session name or null
   */
  getCurrentSession() {
    return this.currentSession;
  }

  /**
   * Set the current session
   * @param {string} session - Session name to set as current
   * @returns {boolean} Success status
   */
  setCurrentSession(session) {
    if (!session) {
      console.warn('[SessionState] Cannot set null session');
      return false;
    }
    
    // Validate session exists
    if (this.availableSessions.length > 0 && !this.availableSessions.includes(session)) {
      console.warn(`[SessionState] Session ${session} not in available sessions`);
      return false;
    }
    
    const previousSession = this.currentSession;
    this.currentSession = session;
    this.saveSession();
    
    // Notify listeners
    this.notifyListeners(session, previousSession);
    
    console.log(`[SessionState] Current session set to: ${session}`);
    return true;
  }

  /**
   * Update available sessions list
   * @param {Array} sessions - New list of available sessions
   */
  updateAvailableSessions(sessions) {
    this.availableSessions = sessions;
    
    // Check if current session is still valid
    if (this.currentSession && !sessions.includes(this.currentSession)) {
      console.warn(`[SessionState] Current session ${this.currentSession} no longer available`);
      // Auto-switch to first available
      if (sessions.length > 0) {
        this.setCurrentSession(sessions[0]);
      } else {
        this.currentSession = null;
        this.saveSession();
      }
    }
  }

  /**
   * Get stored session from localStorage (browser) or file (node)
   * @returns {string|null} Stored session name
   */
  getStoredSession() {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage.getItem(this.storageKey);
    } else if (typeof process !== 'undefined') {
      // Node.js environment - could read from a file
      // For now, return null as we're primarily browser-based
      return null;
    }
    return null;
  }

  /**
   * Save current session to storage
   */
  saveSession() {
    if (typeof window !== 'undefined' && window.localStorage) {
      if (this.currentSession) {
        window.localStorage.setItem(this.storageKey, this.currentSession);
      } else {
        window.localStorage.removeItem(this.storageKey);
      }
    }
  }

  /**
   * Register a listener for session changes
   * @param {Function} callback - Function to call on session change
   * @returns {Function} Unsubscribe function
   */
  onSessionChange(callback) {
    this.listeners.push(callback);
    // Return unsubscribe function
    return () => {
      this.listeners = this.listeners.filter(l => l !== callback);
    };
  }

  /**
   * Notify all listeners of session change
   * @param {string} newSession - New session name
   * @param {string} oldSession - Previous session name
   */
  notifyListeners(newSession, oldSession) {
    this.listeners.forEach(listener => {
      try {
        listener(newSession, oldSession);
      } catch (error) {
        console.error('[SessionState] Error in listener:', error);
      }
    });
  }

  /**
   * Get or create default session
   * Ensures at least one session exists
   * @returns {string} Session name
   */
  async ensureSession() {
    if (this.currentSession) {
      return this.currentSession;
    }
    
    // If no sessions exist, suggest creating claude-loop1
    const defaultSession = 'claude-loop1';
    console.log(`[SessionState] No session selected, suggesting: ${defaultSession}`);
    return defaultSession;
  }
}

// Export for use in both Node.js and browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SessionStateManager;
}

// Create global instance for browser
if (typeof window !== 'undefined') {
  window.SessionStateManager = SessionStateManager;
  window.sessionState = new SessionStateManager();
}