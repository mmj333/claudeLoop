#!/usr/bin/env node

/**
 * Dashboard Utilities
 * Provides text processing functions that can be imported or used globally
 * Avoids regex escaping issues in HTML template literals
 */

const dashboardUtils = {
  /**
   * Format inline code with backticks
   * @param {string} text - Text containing backtick-wrapped code
   * @returns {string} HTML with <code> tags
   */
  formatInlineCode: function(text) {
    // Use actual backticks here - no escaping needed!
    const pattern = /`([^`]+)`/g;
    return text.replace(pattern, '<code>$1</code>');
  },

  /**
   * Format code blocks with triple backticks
   * @param {string} text - Text containing code blocks
   * @returns {string} HTML with formatted code blocks
   */
  formatCodeBlocks: function(text) {
    const parts = text.split('```');
    let result = '';
    
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        // Regular text - escape HTML
        result += this.escapeHtml(parts[i]);
      } else {
        // Code block
        const lines = parts[i].split('\n');
        const lang = lines[0] || 'plaintext';
        const code = lines.slice(1).join('\n');
        result += `<div class="code-block">
          <div class="code-lang">${lang}</div>
          <pre><code>${this.escapeHtml(code)}</code></pre>
        </div>`;
      }
    }
    return result;
  },

  /**
   * Format message content with all enhancements
   * @param {string} content - Raw message content
   * @returns {string} Formatted HTML
   */
  formatMessageContent: function(content) {
    // Check for code blocks first
    if (content.includes('```')) {
      return this.formatCodeBlocks(content);
    }
    
    // Format inline code
    let formatted = this.formatInlineCode(content);
    
    // Escape HTML in non-code parts
    const parts = formatted.split(/(<code>.*?<\/code>)/);
    formatted = parts.map((part, i) => {
      // Even indices are non-code parts
      if (i % 2 === 0) {
        return this.escapeHtml(part);
      }
      return part; // Keep code parts as-is
    }).join('');
    
    return formatted;
  },

  /**
   * Escape HTML special characters
   * @param {string} text - Text to escape
   * @returns {string} Escaped text
   */
  escapeHtml: function(text) {
    // Works in both browser and Node.js
    if (typeof document !== 'undefined') {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    } else {
      // Node.js fallback
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }
  },

  /**
   * Convert ANSI escape codes to HTML
   * @param {string} text - Text with ANSI codes
   * @returns {string} HTML with color spans
   */
  convertAnsiToHtml: function(text) {
    if (!text) return '';
    
    // First escape HTML to prevent XSS
    let processed = text
      .split('&').join('&amp;')
      .split('<').join('&lt;')
      .split('>').join('&gt;')
      .split('"').join('&quot;')
      .split("'").join('&#x27;');
    
    // ANSI color code mapping
    const colorMap = {
      // Reset
      '0': '</span><span>',
      '39': '</span><span>',
      '49': '</span><span>',
      // Text styles
      '1': '</span><span style="font-weight: bold;">',
      '2': '</span><span style="opacity: 0.7;">',
      '3': '</span><span style="font-style: italic;">',
      '4': '</span><span style="text-decoration: underline;">',
      // Standard colors
      '30': '</span><span style="color: #000;">',
      '31': '</span><span style="color: #cc0000;">',
      '32': '</span><span style="color: #4e9a06;">',
      '33': '</span><span style="color: #c4a000;">',
      '34': '</span><span style="color: #3465a4;">',
      '35': '</span><span style="color: #75507b;">',
      '36': '</span><span style="color: #06989a;">',
      '37': '</span><span style="color: #d3d7cf;">',
      // Bright colors
      '90': '</span><span style="color: #555753;">',
      '91': '</span><span style="color: #ef2929;">',
      '92': '</span><span style="color: #8ae234;">',
      '93': '</span><span style="color: #fce94f;">',
      '94': '</span><span style="color: #729fcf;">',
      '95': '</span><span style="color: #ad7fa8;">',
      '96': '</span><span style="color: #34e2e2;">',
      '97': '</span><span style="color: #eeeeec;">',
      // Background colors
      '40': '</span><span style="background-color: #000;">',
      '41': '</span><span style="background-color: #cc0000;">',
      '42': '</span><span style="background-color: #4e9a06;">',
      '43': '</span><span style="background-color: #c4a000;">',
      '44': '</span><span style="background-color: #3465a4;">',
      '45': '</span><span style="background-color: #75507b;">',
      '46': '</span><span style="background-color: #06989a;">',
      '47': '</span><span style="background-color: #d3d7cf;">',
    };
    
    // Replace ANSI codes with HTML
    let result = '<span>';
    let i = 0;
    
    while (i < processed.length) {
      // Look for ESC character (0x1B or \x1b)
      if (processed.charCodeAt(i) === 27 && processed[i+1] === '[') {
        // Find the end of the ANSI code
        let codeEnd = i + 2;
        while (codeEnd < processed.length && processed[codeEnd] !== 'm') {
          codeEnd++;
        }
        
        if (codeEnd < processed.length) {
          const code = processed.substring(i + 2, codeEnd);
          
          // Handle multiple codes separated by semicolons
          const codes = code.split(';');
          for (const c of codes) {
            if (colorMap[c]) {
              result += colorMap[c];
            }
          }
          
          i = codeEnd + 1;
        } else {
          result += processed[i];
          i++;
        }
      } else {
        result += processed[i];
        i++;
      }
    }
    
    result += '</span>';
    
    // Clean up empty spans
    result = result.replace(/<span><\/span>/g, '');
    
    return result;
  },

  /**
   * Format timestamps
   * @param {string} timestamp - ISO timestamp
   * @returns {string} Formatted time
   */
  formatTimestamp: function(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  },

  /**
   * Truncate text with ellipsis
   * @param {string} text - Text to truncate
   * @param {number} maxLength - Maximum length
   * @returns {string} Truncated text
   */
  truncateText: function(text, maxLength = 100) {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  },

  /**
   * Convert ANSI escape codes to HTML for terminal output display
   * @param {string} line - Line containing ANSI codes
   * @returns {string} HTML with color styles
   */
  convertAnsiToHtml: function(line) {
    // First escape HTML to prevent XSS
    let processed = line
      .split('&').join('&amp;')
      .split('<').join('&lt;')
      .split('>').join('&gt;')
      .split('"').join('&quot;')
      .split("'").join('&#x27;');
    
    // Convert ANSI codes to HTML - handle all the patterns
    let result = '';
    let openSpans = [];
    let i = 0;
    
    while (i < processed.length) {
      // Look for ESC character (ASCII 27)
      if (processed.charCodeAt(i) === 27 && processed[i+1] === '[') {
        // Find the end of the ANSI code
        let codeEnd = i + 2;
        while (codeEnd < processed.length && processed[codeEnd] !== 'm') {
          codeEnd++;
        }
        
        if (processed[codeEnd] === 'm') {
          const code = processed.substring(i + 2, codeEnd);
          const replacement = this.processAnsiCode(code);
          
          if (replacement) {
            // Close any open spans if this is a reset
            if (replacement.includes('</span>')) {
              while (openSpans.length > 0) {
                result += '</span>';
                openSpans.pop();
              }
            }
            // Add the new span if it's an opening tag
            if (replacement.includes('<span')) {
              result += replacement;
              openSpans.push(true);
            }
          }
          
          i = codeEnd + 1;
        } else {
          result += processed[i];
          i++;
        }
      } else {
        result += processed[i];
        i++;
      }
    }
    
    // Close any remaining open spans
    while (openSpans.length > 0) {
      result += '</span>';
      openSpans.pop();
    }
    
    return result || processed;
  },

  /**
   * Process individual ANSI code sequences
   * @param {string} code - ANSI code without ESC[ and m
   * @returns {string} HTML span tag or empty string
   */
  processAnsiCode: function(code) {
    // Handle different ANSI codes
    if (code === '0' || code === '') {
      // Reset all
      return '</span><span>';
    } else if (code === '39' || code === '49') {
      // Reset color
      return '</span><span>';
    } else if (code.startsWith('38;2;')) {
      // 24-bit foreground color
      const rgb = code.split(';').slice(2);
      if (rgb.length === 3) {
        return '</span><span style="color: rgb(' + rgb.join(',') + ');">';
      }
    } else if (code.startsWith('48;2;')) {
      // 24-bit background color
      const rgb = code.split(';').slice(2);
      if (rgb.length === 3) {
        return '</span><span style="background-color: rgb(' + rgb.join(',') + ');">';
      }
    } else {
      // Map common ANSI color codes
      const colorMap = {
        '30': 'color: #000000', '31': 'color: #cc0000', '32': 'color: #4e9a06',
        '33': 'color: #c4a000', '34': 'color: #3465a4', '35': 'color: #75507b',
        '36': 'color: #06989a', '37': 'color: #d3d7cf',
        '90': 'color: #555753', '91': 'color: #ef2929', '92': 'color: #8ae234',
        '93': 'color: #fce94f', '94': 'color: #729fcf', '95': 'color: #ad7fa8',
        '96': 'color: #34e2e2', '97': 'color: #eeeeec',
        '40': 'background-color: #000000', '41': 'background-color: #cc0000',
        '42': 'background-color: #4e9a06', '43': 'background-color: #c4a000',
        '44': 'background-color: #3465a4', '45': 'background-color: #75507b',
        '46': 'background-color: #06989a', '47': 'background-color: #d3d7cf',
        '100': 'background-color: #555753', '101': 'background-color: #ef2929',
        '102': 'background-color: #8ae234', '103': 'background-color: #fce94f',
        '104': 'background-color: #729fcf', '105': 'background-color: #ad7fa8',
        '106': 'background-color: #34e2e2', '107': 'background-color: #eeeeec',
        '1': 'font-weight: bold', '3': 'font-style: italic', '4': 'text-decoration: underline'
      };
      
      const style = colorMap[code];
      if (style) {
        return '</span><span style="' + style + ';">';
      }
    }
    return '';
  },

  /**
   * Load chat messages from conversation
   * @returns {Promise<void>}
   */
  loadChatMessages: async function() {
    console.log('Loading chat messages...');
    try {
      // Get current conversation ID from the API
      const convResponse = await fetch('/api/conversation/current');
      const convData = await convResponse.json();
      console.log('Current conversation:', convData);
      
      if (!convData || !convData.conversationId) {
        document.getElementById('chat-messages').innerHTML = 
          '<div style="text-align: center; color: var(--text-secondary); padding: 40px;">' +
          '<div>No active conversation found</div>' +
          '<div style="font-size: 0.9em; margin-top: 10px;">Start a Claude conversation to see messages here</div></div>';
        return;
      }
      
      const currentConv = convData.conversationId;
      
      const response = await fetch('/api/conversation/messages?id=' + currentConv);
      
      if (!response.ok) {
        throw new Error('Failed to load messages');
      }
      
      const messages = await response.json();
      console.log('Loaded messages:', messages.length);
      
      const container = document.getElementById('chat-messages');
      container.innerHTML = '';
      
      messages.forEach(msg => {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'chat-message message-' + msg.type;
        
        const bubble = document.createElement('div');
        bubble.className = 'message-bubble';
        
        // Format the content
        if (typeof msg.content === 'string') {
          bubble.innerHTML = dashboardUtils.formatMessageContent(msg.content);
        } else {
          bubble.textContent = '[Complex message structure]';
        }
        
        messageDiv.appendChild(bubble);
        
        // Add timestamp if available
        if (msg.timestamp) {
          const timestamp = document.createElement('div');
          timestamp.className = 'message-timestamp';
          timestamp.textContent = dashboardUtils.formatTimestamp(msg.timestamp);
          messageDiv.appendChild(timestamp);
        }
        
        container.appendChild(messageDiv);
      });
      
      // Scroll to bottom
      container.scrollTop = container.scrollHeight;
      
    } catch (error) {
      console.error('Error loading chat messages:', error);
      document.getElementById('chat-messages').innerHTML = 
        '<div style="color: var(--danger); padding: 20px;">Error loading messages: ' + error.message + '</div>';
    }
  },

  /**
   * Update mini tmux viewer with latest output
   * @param {string} sessionName - Tmux session name
   * @returns {Promise<void>}
   */
  updateMiniTmux: async function(sessionName = 'claude-chat') {
    try {
      const response = await fetch('/api/tmux-tail?lines=10&session=' + sessionName);
      const data = await response.json();
      
      const content = document.getElementById('mini-tmux-content');
      if (data.content) {
        // Show only last 500 characters
        const truncated = data.content.slice(-500);
        content.innerHTML = dashboardUtils.convertAnsiToHtml(truncated);
      } else {
        content.textContent = 'No tmux output available';
      }
    } catch (error) {
      console.error('Error updating mini tmux:', error);
    }
  }
};

// Export for Node.js environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = dashboardUtils;
}

// Make available globally for browser environments
if (typeof window !== 'undefined') {
  window.dashboardUtils = dashboardUtils;
}