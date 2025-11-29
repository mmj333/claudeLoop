#!/usr/bin/env node

/**
 * Dashboard Conversations Module
 * Provides conversation tree view and management
 */

const dashboardConversations = {
  // State
  conversations: {},
  currentConversationId: null,
  treeExpanded: {},
  folderExpanded: {},
  currentWorkingDirectory: null,
  
  /**
   * Format file size in human readable format
   */
  formatFileSize: function(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  },
  
  /**
   * Get relative time string
   */
  getRelativeTime: function(date) {
    const now = new Date();
    const then = new Date(date);
    const diffMs = now - then;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return diffMins + ' minute' + (diffMins === 1 ? '' : 's') + ' ago';
    if (diffHours < 24) return diffHours + ' hour' + (diffHours === 1 ? '' : 's') + ' ago';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return diffDays + ' days ago';
    return then.toLocaleDateString();
  },
  
  /**
   * Initialize the conversations module
   */
  init: function() {
    console.log('Initializing conversations module...');
    this.loadConversations();
    this.setupTooltips();
  },
  
  /**
   * Setup tooltips to prevent double tooltips
   */
  setupTooltips: function() {
    // Store and remove title attributes on hover to prevent browser tooltips
    document.addEventListener('mouseenter', function(e) {
      // Check if target is an element and has matches method
      if (e.target && e.target.matches) {
        // Handle both conversation-controls and conversation-actions buttons
        if (e.target.matches('.conversation-controls .btn[title]') || 
            e.target.matches('.conversation-actions .btn[title]')) {
          e.target.dataset.originalTitle = e.target.title;
          e.target.removeAttribute('title');
        }
      }
    }, true);
    
    document.addEventListener('mouseleave', function(e) {
      // Check if target is an element and has matches method
      if (e.target && e.target.matches) {
        // Handle both conversation-controls and conversation-actions buttons
        if ((e.target.matches('.conversation-controls .btn') || 
             e.target.matches('.conversation-actions .btn')) && 
            e.target.dataset.originalTitle) {
          e.target.title = e.target.dataset.originalTitle;
          delete e.target.dataset.originalTitle;
        }
      }
    }, true);
  },
  
  /**
   * Load conversations from the server
   */
  loadConversations: async function() {
    try {
      // Get current working directory from config
      if (window.loopConfig && window.loopConfig.workingDirectory) {
        this.currentWorkingDirectory = window.loopConfig.workingDirectory;
      } else {
        this.currentWorkingDirectory = '/home/michael/InfiniQuest'; // Default
      }
      
      // Scan for conversations (uses cache by default)
      const scanResult = await dashboardAPI.scanConversations(false);
      if (scanResult && scanResult.cache && scanResult.cache.conversations) {
        this.conversations = scanResult.cache.conversations;
        
        // Custom names are already loaded during scanning, no need for separate API call
        
        this.renderTree();
        
        // Try to auto-select conversation for current session
        if (window.currentSession) {
          this.autoSelectConversation();
        }
      }
    } catch (error) {
      console.error('Failed to load conversations:', error);
    }
  },
  
  /**
   * Auto-select the conversation for the current session
   */
  autoSelectConversation: async function() {
    try {
      // Get current conversation from server
      const response = await dashboardAPI.getCurrentConversation();
      if (response && response.conversationId) {
        this.selectConversation(response.conversationId);
      }
    } catch (error) {
      console.error('Failed to auto-select conversation:', error);
    }
  },
  
  /**
   * Select a conversation
   */
  selectConversation: function(conversationId) {
    this.currentConversationId = conversationId;
    
    // Update UI to show selection
    document.querySelectorAll('.conversation-item').forEach(item => {
      item.classList.remove('selected');
    });
    
    const selectedItem = document.querySelector(`[data-conversation-id="${conversationId}"]`);
    if (selectedItem) {
      selectedItem.classList.add('selected');
    }
    
    // Show conversation details
    this.showConversationDetails(conversationId);
    
    // Load messages in chat tab if it's active
    if (window.currentTab === 'chat') {
      window.loadChatMessages();
    }
  },
  
  /**
   * Show detailed information about selected conversation
   */
  showConversationDetails: function(conversationId) {
    // Remove any existing details panel
    const existingPanel = document.querySelector('.conversation-details-inline');
    if (existingPanel) {
      existingPanel.remove();
    }
    
    const conv = this.conversations[conversationId];
    if (!conv) {
      console.error('Conversation not found:', conversationId);
      return;
    }
    
    // Find the selected conversation item
    const selectedItem = document.querySelector(`[data-conversation-id="${conversationId}"]`);
    if (!selectedItem) {
      console.error('Selected item not found in DOM');
      return;
    }
    
    // Get full title (not truncated)
    const fullTitle = conv.customName || conv.firstUserMessage || conv.id;
    
    // Get summary if available
    const summary = conv.summary || '';
    
    // Truncate for display in tree, but show full in details
    const displayTitle = fullTitle.length > 200 ? fullTitle.substring(0, 200) + '...' : fullTitle;
    
    let html = `
      <div style="font-size: 13px; color: var(--text-secondary); margin-bottom: 8px;">
        <strong>Conversation Details</strong>
      </div>
      <div style="display: flex; flex-direction: column; gap: 8px;">
        <div style="display: flex; align-items: flex-start; gap: 8px;">
          <span style="color: var(--text-secondary); min-width: 60px; font-size: 13px;">ID:</span>
          <code style="font-family: monospace; font-size: 11px; color: var(--text-secondary); background: var(--bg-tertiary); padding: 2px 6px; border-radius: 3px; word-break: break-all;">
            ${conv.id}
          </code>
        </div>
        
        ${summary && summary !== fullTitle ? `
          <div style="display: flex; align-items: flex-start; gap: 8px;">
            <span style="color: var(--text-secondary); min-width: 60px; font-size: 13px;">Summary:</span>
            <div style="flex: 1; color: var(--accent); line-height: 1.4; font-size: 13px;">
              ${this.escapeHtml(summary)}
            </div>
          </div>
        ` : ''}
        
        <div style="display: flex; align-items: flex-start; gap: 8px;">
          <span style="color: var(--text-secondary); min-width: 60px; font-size: 13px;">Full Text:</span>
          <div style="flex: 1; color: var(--text-primary); line-height: 1.4; font-size: 13px;">
            ${this.escapeHtml(fullTitle)}
          </div>
        </div>
        
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="color: var(--text-secondary); min-width: 60px; font-size: 13px;">Path:</span>
          <span style="color: var(--text-primary); font-size: 13px;">${conv.cwd || 'Unknown'}</span>
        </div>
        
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="color: var(--text-secondary); min-width: 60px; font-size: 13px;">Stats:</span>
          <span style="color: var(--text-primary); font-size: 13px;">
            ${conv.messageCount || 0} messages • ${this.formatFileSize(conv.fileSize || 0)} • ${this.getRelativeTime(conv.lastModified || conv.timestamp)}
          </span>
        </div>
        
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="color: var(--text-secondary); min-width: 60px; font-size: 13px;">Modified:</span>
          <span style="color: var(--text-primary); font-size: 12px;">${new Date(conv.lastModified || conv.timestamp).toLocaleString()}</span>
        </div>
        
        ${conv.isCompactSummary ? `
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="color: var(--text-secondary); min-width: 60px; font-size: 13px;">Type:</span>
            <span style="color: var(--accent); font-size: 13px;">📦 Compacted Conversation</span>
          </div>
        ` : ''}
      </div>
    `;
    
    // Create the details panel element
    const detailsPanel = document.createElement('div');
    detailsPanel.className = 'conversation-details-inline';
    detailsPanel.style.cssText = `
      margin: 8px 0 8px ${selectedItem.style.paddingLeft};
      padding: 10px;
      background: var(--bg-secondary);
      border-radius: 6px;
      border: 1px solid var(--border-color);
      animation: slideDown 0.2s ease-out;
    `;
    detailsPanel.innerHTML = html;
    
    // Insert the panel right after the selected conversation item
    selectedItem.insertAdjacentElement('afterend', detailsPanel);
  },
  
  
  /**
   * Render the conversation tree
   */
  renderTree: function() {
    const container = document.getElementById('conversation-tree');
    if (!container) return;
    
    // Build folder structure
    const folders = this.buildFolderStructure(this.conversations);
    
    // Render HTML
    let html = '<div class="conversation-tree-list">';
    
    // Render folders
    folders.forEach(folder => {
      html += this.renderFolder(folder);
    });
    
    html += '</div>';
    
    container.innerHTML = html;
  },
  
  /**
   * Build folder structure from conversations
   */
  buildFolderStructure: function(conversations) {
    const folders = {};
    const unknownFolder = {
      path: 'Unknown/Unmatched',
      displayName: '❓ Unknown/Unmatched',
      conversations: [],
      isCurrentCwd: false,
      conversationCount: 0
    };
    
    // Group conversations by CWD
    for (const id in conversations) {
      const conv = conversations[id];
      const cwd = conv.cwd || 'unknown';
      
      if (cwd === 'unknown' || !cwd) {
        unknownFolder.conversations.push(conv);
      } else {
        if (!folders[cwd]) {
          folders[cwd] = {
            path: cwd,
            displayName: this.formatFolderName(cwd),
            conversations: [],
            isCurrentCwd: cwd === this.currentWorkingDirectory,
            conversationCount: 0
          };
        }
        folders[cwd].conversations.push(conv);
      }
    }
    
    // Build tree structure within each folder
    Object.values(folders).forEach(folder => {
      folder.conversations = this.buildTreeStructure(folder.conversations);
      folder.conversationCount = folder.conversations.length;
    });
    
    if (unknownFolder.conversations.length > 0) {
      unknownFolder.conversations = this.buildTreeStructure(unknownFolder.conversations);
      unknownFolder.conversationCount = unknownFolder.conversations.length;
    }
    
    // Sort folders - current CWD first, then alphabetically
    const sortedFolders = [];
    
    // Add current CWD folder first if it exists
    const currentCwdFolder = folders[this.currentWorkingDirectory];
    if (currentCwdFolder) {
      sortedFolders.push(currentCwdFolder);
      delete folders[this.currentWorkingDirectory];
    }
    
    // Add other folders alphabetically
    Object.keys(folders).sort().forEach(key => {
      sortedFolders.push(folders[key]);
    });
    
    // Add unknown folder last if it has conversations
    if (unknownFolder.conversationCount > 0) {
      sortedFolders.push(unknownFolder);
    }
    
    return sortedFolders;
  },
  
  /**
   * Format folder name for display
   */
  formatFolderName: function(path) {
    // Get just the last part of the path for brevity
    const parts = path.split('/');
    const lastPart = parts[parts.length - 1] || parts[parts.length - 2];
    
    // Add icon based on common folder names
    let icon = '📁';
    if (path === this.currentWorkingDirectory) {
      icon = '📂'; // Open folder for current
    } else if (path.includes('InfiniQuest')) {
      icon = '🎮';
    } else if (path.includes('dashboard')) {
      icon = '🎨';
    } else if (path.includes('test')) {
      icon = '🧪';
    }
    
    return `${icon} ${lastPart}`;
  },
  
  /**
   * Build tree structure from flat conversation list
   */
  buildTreeStructure: function(conversations) {
    const convArray = Array.isArray(conversations) ? conversations : Object.values(conversations);
    const roots = [];
    
    // Find root conversations (no parent or parent not in list)
    convArray.forEach(conv => {
      if (!conv.parentId || !this.conversations[conv.parentId]) {
        roots.push(conv);
      }
    });
    
    // Sort by timestamp (newest first)
    roots.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    return roots;
  },
  
  /**
   * Render a folder with its conversations
   */
  renderFolder: function(folder) {
    // Only expand the current CWD folder by default, collapse all others
    let isExpanded;
    if (this.folderExpanded[folder.path] !== undefined) {
      // User has manually toggled this folder, respect their choice
      isExpanded = this.folderExpanded[folder.path];
    } else {
      // Default: only expand if it's the current CWD folder
      isExpanded = folder.isCurrentCwd;
    }
    const folderClass = folder.isCurrentCwd ? 'folder-current' : '';
    
    let html = `
      <div class="conversation-folder ${folderClass}">
        <div class="folder-header" onclick="dashboardConversations.toggleFolder('${this.escapeHtml(folder.path)}')">
          <span class="folder-toggle">${isExpanded ? '▼' : '▶'}</span>
          <span class="folder-name">${this.escapeHtml(folder.displayName)}</span>
          <span class="folder-count">[${folder.conversationCount}]</span>
          ${folder.isCurrentCwd ? '<span class="folder-badge">current</span>' : ''}
        </div>
        <div class="folder-content" style="${isExpanded ? '' : 'display: none;'}">
    `;
    
    // Render conversations in this folder
    folder.conversations.forEach(conv => {
      html += this.renderConversationNode(conv, 1);
    });
    
    html += `
        </div>
      </div>
    `;
    
    return html;
  },
  
  /**
   * Toggle folder expand/collapse
   */
  toggleFolder: function(folderPath) {
    this.folderExpanded[folderPath] = !this.folderExpanded[folderPath];
    this.renderTree();
  },
  
  /**
   * Render a single conversation node and its children
   */
  renderConversationNode: function(conv, depth) {
    const hasChildren = conv.children && conv.children.length > 0;
    const isExpanded = this.treeExpanded[conv.id] !== false; // Default to expanded
    const isSelected = conv.id === this.currentConversationId;
    
    // Use custom name, then first user message, then conversation ID
    let title = conv.customName || conv.firstUserMessage || conv.id;
    // Don't truncate here - let CSS handle overflow with ellipsis
    
    // Format metadata
    const messageCount = conv.messageCount || 0;
    const fileSize = this.formatFileSize(conv.fileSize || 0);
    const timeAgo = this.getRelativeTime(conv.lastModified || conv.timestamp);
    const isCompact = conv.isCompactSummary;
    const isSidechain = conv.isSidechain;
    const isFork = conv.parentId && this.conversations[conv.parentId] ? '└─' : '';
    
    // Determine icon
    let icon = '💬';
    if (conv.parentId) icon = '🔀'; // Fork
    if (conv.isCompactSummary) icon = '📦'; // Compact summary
    
    let html = `
      <div class="conversation-item ${isSelected ? 'selected' : ''}" 
           data-conversation-id="${conv.id}"
           style="padding-left: ${depth * 24}px;">
        <div class="conversation-row">
          <div class="conversation-header" onclick="dashboardConversations.handleConversationClick('${conv.id}', event)">
            <span class="tree-line">${isFork}</span>
            ${hasChildren ? `
              <span class="tree-toggle" onclick="dashboardConversations.toggleExpand('${conv.id}', event)">
                ${isExpanded ? '▼' : '▶'}
              </span>
            ` : '<span class="tree-spacer"></span>'}
            <span class="conversation-icon">${icon}</span>
            <span class="conversation-title" 
                  title="${this.escapeHtml(title)}"
                  ondblclick="dashboardConversations.renameConversation('${conv.id}'); event.stopPropagation();">
              ${this.escapeHtml(title)}
            </span>
            <span class="conversation-meta">
              ${messageCount} msgs • ${fileSize} • ${timeAgo}
              ${isCompact ? ' 📦' : ''}${isSidechain ? ' 🔀' : ''}
            </span>
          </div>
          <div class="conversation-actions">
            <button onclick="dashboardConversations.assignConversation('${conv.id}')" 
                    class="btn btn-xs" title="Pin conversation - Marks this as the default conversation for this tmux session. If you restart the Claude loop or start a new one, it will use this conversation. Does NOT affect currently running Claude sessions.">📍</button>
            ${!conv.parentId ? `<button onclick="dashboardConversations.resumeConversation('${conv.id}')" 
                    class="btn btn-xs btn-success" title="Resume conversation - Stops any running loop and starts a fresh Claude session with this conversation. Changes to the conversation's working directory and continues from where it left off.">▶️</button>` : 
                    `<button class="btn btn-xs btn-disabled" disabled title="Child conversations cannot be resumed directly. Only root conversations can be resumed with 'claude --resume'.">▶️</button>`}
            <button onclick="dashboardConversations.deleteConversation('${conv.id}')" 
                    class="btn btn-xs btn-danger" title="Delete conversation - Moves this conversation file to trash. Can be recovered from ~/.claude/trash/ if needed. Won't affect running sessions.">🗑️</button>
          </div>
        </div>
      </div>
    `;
    
    // Render children if expanded
    if (hasChildren && isExpanded) {
      conv.children.forEach(childId => {
        const child = this.conversations[childId];
        if (child) {
          html += this.renderConversationNode(child, depth + 1);
        }
      });
    }
    
    return html;
  },
  
  /**
   * Handle conversation click
   */
  handleConversationClick: function(conversationId, event) {
    // Don't select if clicking on toggle
    if (event && event.target && event.target.classList && event.target.classList.contains('tree-toggle')) {
      return;
    }
    
    // Just call selectConversation which handles everything
    this.selectConversation(conversationId);
  },
  
  /**
   * Toggle expand/collapse for a conversation
   */
  toggleExpand: function(conversationId, event) {
    event.stopPropagation();
    this.treeExpanded[conversationId] = !this.treeExpanded[conversationId];
    this.renderTree();
  },
  
  /**
   * Escape HTML for safe display
   */
  escapeHtml: function(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  },
  
  /**
   * Toggle the conversations panel
   */
  togglePanel: function() {
    const card = document.getElementById('conversations-card');
    const content = document.getElementById('conversations-content');
    const toggle = card?.querySelector('.toggle');
    
    if (!card || !content) return;
    
    if (card.classList.contains('collapsed')) {
      card.classList.remove('collapsed');
      content.style.display = 'block';
      if (toggle) toggle.textContent = '▼';
      this.init(); // Initialize when opened
    } else {
      card.classList.add('collapsed');
      content.style.display = 'none';
      if (toggle) toggle.textContent = '▶';
    }
  },
  
  /**
   * Refresh conversations (quick scan - uses cache)
   */
  refresh: async function() {
    await this.loadConversations();
  },
  
  /**
   * Full refresh - re-reads all JSONL files
   */
  fullRefresh: async function() {
    try {
      // Show loading indicator
      const treeContainer = document.getElementById('conversation-tree');
      if (treeContainer) {
        treeContainer.innerHTML = '<div class="loading">Scanning conversations... This may take a moment...</div>';
      }
      
      // Trigger full scan
      const scanResult = await dashboardAPI.scanConversations(true); // true = force full scan
      
      if (scanResult && scanResult.cache && scanResult.cache.conversations) {
        this.conversations = scanResult.cache.conversations;
        
        // Custom names are already merged in the cache after full scan
        this.renderTree();
        
        // Show completion message
        const message = `Full scan complete: ${Object.keys(this.conversations).length} conversations`;
        console.log(message);
        
        // Try to auto-select conversation for current session
        if (window.currentSession) {
          this.autoSelectConversation();
        }
      }
    } catch (error) {
      console.error('Failed to perform full refresh:', error);
      const treeContainer = document.getElementById('conversation-tree');
      if (treeContainer) {
        treeContainer.innerHTML = '<div class="error">Failed to scan conversations: ' + error.message + '</div>';
      }
    }
  },
  
  /**
   * Assign conversation to current session
   */
  assignConversation: async function(conversationId) {
    try {
      const response = await dashboardAPI.request('/api/conversation/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          conversationId: conversationId,
          session: window.currentSession || 'claude'
        })
      });
      
      if (response.success) {
        // Success - no notification needed
        this.currentConversationId = conversationId;
        this.renderTree();
      }
    } catch (error) {
      console.error('Failed to assign conversation:', error);
      alert('Failed to assign conversation: ' + error.message);
    }
  },
  
  /**
   * Resume Claude with selected conversation
   */
  resumeConversation: async function(conversationId) {
    try {
      // First assign it
      await this.assignConversation(conversationId);
      
      // Get conversation details for CWD
      const conv = this.conversations[conversationId];
      if (conv && conv.cwd && conv.cwd !== 'unknown') {
        // Update working directory
        if (window.updateWorkingDirectory) {
          window.updateWorkingDirectory(conv.cwd);
        }
      }
      
      // Start Claude with this conversation
      const response = await dashboardAPI.request('/api/conversation/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          conversationId: conversationId,
          session: window.currentSession || 'claude',
          cwd: conv.cwd
        })
      });
      
      if (response.success) {
        // Success - no notification needed
      }
    } catch (error) {
      console.error('Failed to resume conversation:', error);
      alert('Failed to resume conversation: ' + error.message);
    }
  },
  
  /**
   * Rename conversation (triggered by double-click)
   */
  renameConversation: async function(conversationId) {
    const conv = this.conversations[conversationId];
    const currentName = conv.customName || conv.firstUserMessage || conversationId;
    const newName = prompt('Rename conversation (tip: double-click any title to rename):', currentName);
    
    if (!newName || newName === currentName) return;
    
    try {
      const response = await dashboardAPI.request('/api/conversation/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          conversationId: conversationId,
          name: newName
        })
      });
      
      if (response.success) {
        // Update local data
        if (this.conversations[conversationId]) {
          this.conversations[conversationId].firstUserMessage = newName;
        }
        this.renderTree();
      }
    } catch (error) {
      console.error('Failed to rename conversation:', error);
      alert('Failed to rename conversation: ' + error.message);
    }
  },
  
  /**
   * Delete conversation (move to trash)
   */
  deleteConversation: async function(conversationId) {
    const conv = this.conversations[conversationId];
    const name = conv.firstUserMessage || conversationId;
    
    if (!confirm(`Are you sure you want to delete this conversation?\n\n"${name}"\n\nThe conversation will be moved to trash and can be recovered if needed.`)) {
      return;
    }
    
    try {
      const response = await dashboardAPI.request('/api/conversation/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          conversationId: conversationId,
          filePath: conv.filePath
        })
      });
      
      if (response.success) {
        // Remove from local data
        delete this.conversations[conversationId];
        this.renderTree();
      }
    } catch (error) {
      console.error('Failed to delete conversation:', error);
      alert('Failed to delete conversation: ' + error.message);
    }
  },
  
  /**
   * Filter conversations based on search text
   */
  filterConversations: function(searchText) {
    const searchLower = searchText.toLowerCase();
    
    // If empty, show all
    if (!searchText.trim()) {
      this.renderTree();
      return;
    }
    
    // Filter conversations
    const filtered = {};
    for (const id in this.conversations) {
      const conv = this.conversations[id];
      const title = conv.firstUserMessage || '';
      const cwd = conv.cwd || '';
      
      if (title.toLowerCase().includes(searchLower) || 
          cwd.toLowerCase().includes(searchLower) ||
          id.toLowerCase().includes(searchLower)) {
        filtered[id] = conv;
      }
    }
    
    // Build and render filtered structure
    const folders = this.buildFolderStructure(filtered);
    const container = document.getElementById('conversation-tree');
    if (!container) return;
    
    let html = '<div class="conversation-tree-list">';
    folders.forEach(folder => {
      html += this.renderFolder(folder);
    });
    html += '</div>';
    
    container.innerHTML = html;
  }
};

// Export for Node.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = dashboardConversations;
}

// Make available globally in browser
if (typeof window !== 'undefined') {
  window.dashboardConversations = dashboardConversations;
}