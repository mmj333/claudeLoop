/**
 * Dashboard Chat Module
 * Handles all chat-related functionality for the Claude Loop Dashboard
 */

window.dashboardChat = {
  // State tracking
  lastMessageIndex: -1,
  currentConversationId: null,
  
  /**
   * Initialize the chat module
   */
  init() {
    console.log('[Chat] Module initialized');
  },
  
  /**
   * Auto-associate conversation based on tmux content
   */
  async autoAssociateConversation() {
    const session = window.currentSession || 'claude';
    const statusDiv = document.getElementById('conversation-association');
    
    try {
      statusDiv.innerHTML = '<span style="color: var(--accent);">🔍 Searching for matching conversation...</span>';
      
      const response = await dashboardAPI.request('/api/conversation/auto-associate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session })
      });
      
      if (response.success) {
        const source = response.source || (response.matchScore > 0 ? 'text match' : 'recent');
        const scoreInfo = response.matchScore ? ` (score: ${response.matchScore})` : '';
        statusDiv.innerHTML = `<span style="color: var(--success);">✅ Found via ${source}: ${response.conversationId.substring(0, 8)}...${scoreInfo}</span>`;
        
        // Update session-map to remember this association
        window.currentConversationId = response.conversationId;
        
        // Force full reload since we have a new conversation
        await this.loadChatMessages(true);
      } else {
        throw new Error(response.error || 'Failed to auto-associate');
      }
    } catch (error) {
      console.error('Auto-associate failed:', error);
      statusDiv.innerHTML = `<span style="color: var(--danger);">❌ ${error.message}</span>`;
    }
  },
  
  /**
   * Load chat messages (full or incremental)
   * @param {boolean} forceFullReload - Force a complete reload of all messages
   */
  async loadChatMessages(forceFullReload = false) {
    try {
      // Get current conversation
      const convResponse = await dashboardAPI.getCurrentConversation();
      
      // Update association status
      const statusDiv = document.getElementById('conversation-association');
      if (statusDiv) {
        if (convResponse.conversationId) {
          statusDiv.innerHTML = `<span style="color: var(--text-muted);">📍 ${convResponse.conversationId.substring(0, 8)}...</span>`;
        } else {
          statusDiv.innerHTML = '<span style="color: var(--text-muted);">No conversation associated</span>';
        }
      }
      
      if (!convResponse.conversationId) {
        document.getElementById('chat-content').innerHTML = '<div class="empty">No active conversation</div>';
        this.lastMessageIndex = -1;
        this.currentConversationId = null;
        return;
      }
      
      // Check if conversation changed
      if (this.currentConversationId !== convResponse.conversationId) {
        forceFullReload = true;
        this.currentConversationId = convResponse.conversationId;
        this.lastMessageIndex = -1;
      }
      
      const container = document.getElementById('chat-content');
      
      // Check if we're at the bottom before updating (for auto-scroll)
      // Look for the messages container which has the scroll
      const messagesContainer = container.querySelector('.chat-messages');
      const wasAtBottom = messagesContainer ? 
        Math.abs(messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight) < 50 :
        true; // Default to true if no container yet
      
      // Get messages - either full load or incremental
      let messages;
      if (!forceFullReload && this.lastMessageIndex >= 0) {
        // Try incremental update
        const response = await fetch(`/api/conversation/messages?id=${convResponse.conversationId}&after=${this.lastMessageIndex}`);
        const data = await response.json();
        
        if (data.messages && data.messages.length > 0) {
          // Append new messages to existing content (reuse messagesContainer from above)
          if (messagesContainer) {
            // Add each new message
            data.messages.forEach(msg => {
              const messageElement = this.createMessageElement(msg);
              messagesContainer.appendChild(messageElement);
              
              // Update last message index
              if (msg.index > this.lastMessageIndex) {
                this.lastMessageIndex = msg.index;
              }
            });
            
            // Auto-scroll if needed
            if (document.getElementById('auto-scroll').checked && wasAtBottom) {
              // Scroll the messages container, not the outer container
              requestAnimationFrame(() => {
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
              });
            }
          } else {
            // No existing container, do full reload
            forceFullReload = true;
          }
        }
        // If no new messages, we're done
        if (!forceFullReload) return;
      }
      
      // Full reload - but only get last 50 messages for initial load
      messages = await dashboardAPI.getConversationMessages(convResponse.conversationId, 50);
      
      if (messages && messages.length > 0) {
        // Track the highest index
        messages.forEach(msg => {
          if (msg.index > this.lastMessageIndex) {
            this.lastMessageIndex = msg.index;
          }
        });
        
        // Create container and add all messages
        const messagesContainer = document.createElement('div');
        messagesContainer.className = 'chat-messages';
        
        messages.forEach(msg => {
          const messageElement = this.createMessageElement(msg);
          messagesContainer.appendChild(messageElement);
        });
        
        container.innerHTML = '';
        container.appendChild(messagesContainer);
        
        // Scroll the INNER messages container, not the outer one!
        const scrollToBottom = () => {
          // Use requestAnimationFrame to ensure browser has completed layout
          requestAnimationFrame(() => {
            // Scroll the messages container itself, which has overflow-y: auto
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
            console.log('[Chat] Scrolled messages container to bottom:', messagesContainer.scrollTop, '/', messagesContainer.scrollHeight);
          });
        };
        
        // Try multiple times to ensure content is loaded
        scrollToBottom();
        setTimeout(scrollToBottom, 0);
        setTimeout(scrollToBottom, 100);
        setTimeout(scrollToBottom, 300);
      } else {
        container.innerHTML = '<div class="empty">No messages yet</div>';
      }
    } catch (error) {
      console.error('Failed to load chat messages:', error);
      document.getElementById('chat-content').innerHTML = 
        '<div class="error">Failed to load messages: ' + error.message + '</div>';
    }
  },
  
  /**
   * Create a message DOM element
   * @param {Object} msg - Message object with type and content
   * @returns {HTMLElement} Message element
   */
  createMessageElement(msg) {
    const isUser = msg.type === 'user';
    const alignClass = isUser ? 'message-right' : 'message-left';
    const typeClass = isUser ? 'user' : 'assistant';
    
    const messageDiv = document.createElement('div');
    messageDiv.className = `chat-message ${alignClass} ${typeClass}`;
    messageDiv.innerHTML = `
      <div class="message-header ${typeClass}-header">
        ${isUser ? '👤 User' : '🤖 Assistant'}
      </div>
      <div class="message-bubble">
        ${dashboardUtils.formatMessageContent ? 
          dashboardUtils.formatMessageContent(msg.content) : 
          msg.content}
      </div>
    `;
    
    return messageDiv;
  },
  
  /**
   * Clear the chat and reset state
   */
  clearChat() {
    document.getElementById('chat-content').innerHTML = '<div class="loading">Loading chat messages...</div>';
    this.lastMessageIndex = -1;
    this.currentConversationId = null;
  },
  
  /**
   * Refresh chat (called by interval)
   */
  async refresh() {
    await this.loadChatMessages(false);
  },
  
  /**
   * Handle session switch
   */
  async onSessionSwitch() {
    // Try to auto-detect conversation for the new session
    await this.autoAssociateConversation();
    // autoAssociateConversation calls loadChatMessages(true) which handles scrolling
  },
  
  /**
   * Handle tab switch to chat
   */
  async onTabSwitch() {
    // Only do incremental update when switching to chat tab
    // unless we have no messages loaded yet
    const needsFullLoad = this.lastMessageIndex < 0 || !this.currentConversationId;
    await this.loadChatMessages(needsFullLoad);
  }
};

// Export for use in dashboard
if (typeof module !== 'undefined' && module.exports) {
  module.exports = dashboardChat;
}

// Make available globally for browser
if (typeof window !== 'undefined') {
  window.dashboardChat = dashboardChat;
}