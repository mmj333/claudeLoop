#!/usr/bin/env node

/**
 * Dashboard API Module
 * Centralizes all API calls for the Claude Loop Dashboard
 */

const dashboardAPI = {
  /**
   * Base API request handler with error handling
   * @param {string} url - API endpoint
   * @param {object} options - Fetch options
   * @returns {Promise<any>} Response data
   */
  async request(url, options = {}) {
    try {
      const response = await fetch(url, options);
      
      // Handle non-JSON responses
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('text/plain')) {
        return response.text();
      }
      
      // Default to JSON
      if (response.ok) {
        return response.json();
      } else {
        const error = await response.text();
        throw new Error(error || `API request failed: ${response.status}`);
      }
    } catch (error) {
      console.error('API request failed:', url, error);
      throw error;
    }
  },

  /**
   * POST request helper
   * @param {string} url - API endpoint
   * @param {object} data - Request body
   * @returns {Promise<any>} Response data
   */
  async post(url, data) {
    return this.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  },

  // Session Management APIs
  async getTmuxSessions() {
    return this.request('/api/tmux-sessions');
  },

  async createTmuxSession(session) {
    return this.post('/api/tmux-setup', { session, action: 'create' });
  },

  async killTmuxSession(session) {
    return this.post('/api/kill-session', { session });
  },

  // Configuration APIs
  async getConfig(session = null) {
    const url = session ? `/api/config?session=${session}` : '/api/config';
    return this.request(url);
  },

  async saveConfig(config, session = null) {
    return this.post('/api/config', { ...config, session });
  },

  async getScheduleConfig() {
    return this.request('/api/schedule-config');
  },

  async saveScheduleConfig(config) {
    return this.post('/api/schedule-config', config);
  },

  // Control APIs
  async sendControl(action, session = null) {
    return this.post('/api/control', { action, session });
  },

  async sendMessage(message, session = null) {
    return this.post('/api/send-custom-message', { message, session });
  },

  async sendToTmux(command, session = null) {
    return this.post('/api/tmux-command', { command, session });
  },
  
  async sendTmuxKey(session, key) {
    return this.post('/api/tmux-send-key', { session, key });
  },

  // Status APIs
  async getStatus(session = null) {
    const url = session ? `/api/status?session=${session}` : '/api/status';
    return this.request(url);
  },

  async getContext(session = null) {
    const url = session ? `/api/context?session=${session}` : '/api/context';
    return this.request(url);
  },

  async getAutoResumeStatus() {
    return this.request('/api/auto-resume-status');
  },

  // Log APIs
  async getLogs(lines = 50, session = null) {
    const url = session 
      ? `/api/logs?lines=${lines}&session=${session}`
      : `/api/logs?lines=${lines}`;
    return this.request(url);
  },

  async getTmuxTail(lines = 10, session = null) {
    const url = session
      ? `/api/tmux-tail?lines=${lines}&session=${session}`
      : `/api/tmux-tail?lines=${lines}`;
    return this.request(url);
  },

  async getTmuxLogs(tail = false, session = null) {
    const url = session
      ? `/api/tmux-logs?tail=${tail}&session=${session}`
      : `/api/tmux-logs?tail=${tail}`;
    return this.request(url);
  },

  // Monitor APIs
  async getLogMonitorStatus(instance = null) {
    const url = instance 
      ? `/api/log-monitor/status?instance=${encodeURIComponent(instance)}`
      : '/api/log-monitor/status';
    return this.request(url);
  },

  async startLogMonitor(type, session) {
    return this.post('/api/log-monitor', { 
      action: 'start', 
      monitorType: type,
      instance: session 
    });
  },

  async stopLogMonitor(session) {
    return this.post('/api/log-monitor', {
      action: 'stop',
      instance: session
    });
  },

  async setMonitorType(type) {
    return this.post('/api/monitor-type', { type });
  },

  // Conversation APIs
  async scanConversations(full = false) {
    return this.request(`/api/conversation/scan?full=${full}`);
  },

  async getConversationList(grouped = false) {
    return this.request(`/api/conversation/list?grouped=${grouped}`);
  },

  async getConversationTree() {
    return this.request('/api/conversation/tree');
  },

  async getCurrentConversation() {
    return this.request('/api/conversation/current');
  },

  async getConversation(session) {
    return this.request(`/api/conversation/get?session=${session}`);
  },

  async getConversationMessages(conversationId) {
    return this.request(`/api/conversation/messages?id=${conversationId}`);
  },

  async trackConversation(conversationId, session) {
    return this.post('/api/conversation/track', { conversationId, session });
  },

  async assignConversation(conversationId, project) {
    return this.post('/api/conversation/assign', { conversationId, project });
  },

  async renameConversation(conversationId, name) {
    return this.post('/api/conversation/name', { conversationId, name });
  },

  async deleteConversation(conversationId) {
    return this.post('/api/conversation/delete', { conversationId });
  },

  // File Browser APIs
  async browseDirectory(path) {
    return this.post('/api/browse-directory', { path });
  },

  // Test APIs
  async testMessage() {
    return this.post('/api/test-message', {});
  },

  async testSave() {
    return this.post('/api/test-save', {});
  },

  // Config APIs
  async saveConfig(config, session) {
    return this.post('/api/config', { config, session });
  },

  // Conditional Message APIs
  async getActiveConditionalMessage(session = 'claude') {
    const response = await fetch(`/api/conditional-message?session=${session}`);
    if (!response.ok) throw new Error('Failed to get conditional message');
    return response.json();
  }
};

// Export for Node.js environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = dashboardAPI;
}

// Make available globally for browser environments
if (typeof window !== 'undefined') {
  window.dashboardAPI = dashboardAPI;
}