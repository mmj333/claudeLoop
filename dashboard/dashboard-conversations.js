#!/usr/bin/env node

/**
 * Dashboard Conversations Module
 * Provides conversation tree view and management
 */

window.dashboardConversations = {
  // State
  conversations: {},
  currentConversationId: null,
  treeExpanded: {},
  folderExpanded: {},
  currentWorkingDirectory: null,
  showConversationDetails: localStorage.getItem('showConversationDetails') !== 'false', // Default to true
  conversationsLoaded: false, // Track if conversations are loaded
  treeRendered: false, // Track if tree has been rendered
  
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
    
    // Initialize toggle button state
    const icon = document.getElementById('toggle-actions-icon');
    if (icon) {
      icon.textContent = this.showConversationDetails ? '👁️' : '👁️‍🗨️';
    }
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
      
      // Load conversations from cache only (no scanning)
      console.log('Loading conversations from cache only...');
      const scanResult = await dashboardAPI.scanConversations(false, true); // false = not full scan, true = cache only
      if (scanResult && scanResult.cache && scanResult.cache.conversations) {
        this.conversations = scanResult.cache.conversations;
        this.conversationsLoaded = true;
        console.log(`Loaded ${Object.keys(this.conversations).length} conversations`);
        
        // Custom names are already loaded during scanning, no need for separate API call
        
        // Only render if the panel is visible
        const content = document.getElementById('conversations-content');
        if (content && content.style.display !== 'none') {
          this.renderTree();
          this.treeRendered = true;
        }
        
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
      // Get current session from dashboard-main
      const currentSession = window.currentSession || document.getElementById('session-select')?.value || 'claude';
      
      // Get current conversation from server for this session
      const response = await dashboardAPI.getCurrentConversation(currentSession);
      if (response && response.conversationId) {
        // Set as current conversation
        this.currentConversationId = response.conversationId;
        this.selectConversation(response.conversationId);
        console.log('Auto-selected conversation:', response.conversationId, 'for session:', currentSession);
        
        // Always re-render to show the "current" badge
        // Even if tree wasn't rendered yet, this will ensure it shows when it does render
        if (this.conversationTree) {
          this.renderTree();
        } else {
          // If tree data isn't loaded yet, flag that we need to show current when it loads
          this.pendingCurrentId = response.conversationId;
        }
      } else {
        console.warn('No current conversation found to auto-select');
        // Optionally show a user-friendly message
        const treeContainer = document.getElementById('conversation-tree');
        if (treeContainer && treeContainer.querySelector('.no-current-conversation-notice')) {
          // Remove any existing notice
          const oldNotice = treeContainer.querySelector('.no-current-conversation-notice');
          if (oldNotice) oldNotice.remove();
        }
        // Add a temporary notice
        const notice = document.createElement('div');
        notice.className = 'no-current-conversation-notice';
        notice.style.cssText = 'padding: 8px; background: var(--bg-warning); color: var(--text-warning); border-radius: 4px; margin-bottom: 8px;';
        notice.textContent = 'No active conversation found for current Claude session';
        if (treeContainer) {
          treeContainer.insertBefore(notice, treeContainer.firstChild);
          // Remove notice after 5 seconds
          setTimeout(() => notice.remove(), 5000);
        }
      }
    } catch (error) {
      console.error('Failed to auto-select conversation:', error);
      throw error; // Re-throw to be caught by button handler
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
    
    // Show conversation details only if toggle is on
    if (this.showConversationDetails) {
      this.displayConversationDetails(conversationId);
    }
    
    // Load messages in chat tab if it's active
    if (window.currentTab === 'chat') {
      window.loadChatMessages();
    }

    // Load native todos for this conversation
    if (window.dashboardNativeTodos) {
      window.dashboardNativeTodos.loadForConversation(conversationId);
    }
  },
  
  /**
   * Show detailed information about selected conversation
   */
  displayConversationDetails: function(conversationId) {
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
            ${conv.messageCount || 0} messages • ${this.formatFileSize(conv.fileSize || 0)} • ${this.getRelativeTime(this.getMostRecentActivity(conv))}
          </span>
        </div>
        
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="color: var(--text-secondary); min-width: 60px; font-size: 13px;">Modified:</span>
          <span style="color: var(--text-primary); font-size: 12px;">${new Date(this.getMostRecentActivity(conv)).toLocaleString()}</span>
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
      animation: slideDown 0.6s ease-out;
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
    this.treeRendered = true;
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
      // Use projectRoot for grouping, fallback to cwd
      const folderPath = conv.projectRoot || conv.cwd || 'unknown';
      
      if (folderPath === 'unknown' || !folderPath) {
        unknownFolder.conversations.push(conv);
      } else {
        if (!folders[folderPath]) {
          folders[folderPath] = {
            path: folderPath,
            displayName: this.formatFolderName(folderPath),
            conversations: [],
            isCurrentCwd: folderPath === this.currentWorkingDirectory,
            conversationCount: 0
          };
        }
        folders[folderPath].conversations.push(conv);
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
    
    // Sort folders - current CWD first, then by most recent activity
    const sortedFolders = [];
    
    // Add current CWD folder first if it exists
    const currentCwdFolder = folders[this.currentWorkingDirectory];
    if (currentCwdFolder) {
      sortedFolders.push(currentCwdFolder);
      delete folders[this.currentWorkingDirectory];
    }
    
    // Calculate most recent activity for each folder
    Object.values(folders).forEach(folder => {
      let mostRecent = new Date(0);
      folder.conversations.forEach(conv => {
        const convRecent = this.getMostRecentActivity(conv);
        if (convRecent > mostRecent) {
          mostRecent = convRecent;
        }
      });
      folder.mostRecentActivity = mostRecent;
    });
    
    // Sort other folders by most recent activity
    Object.values(folders)
      .sort((a, b) => b.mostRecentActivity - a.mostRecentActivity)
      .forEach(folder => sortedFolders.push(folder));
    
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
    // For better visibility, show more of the path if it's a project folder
    const parts = path.split('/').filter(p => p); // Remove empty parts
    let displayPath;
    
    // If it's in home directory, show from home onwards
    if (path.startsWith('/home/')) {
      // Show last 2-3 parts for context
      if (parts.length > 3) {
        displayPath = parts.slice(-2).join('/');
      } else if (parts.length > 2) {
        displayPath = parts.slice(2).join('/');
      } else {
        displayPath = parts[parts.length - 1] || path;
      }
    } else {
      // For other paths, just show the last part
      displayPath = parts[parts.length - 1] || path;
    }
    
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
    } else if (path.includes('Computer') || path.includes('Repair')) {
      icon = '💻';
    }
    
    return `${icon} ${displayPath}`;
  },
  
  /**
   * Get most recent activity timestamp for a conversation and all its descendants
   */
  getMostRecentActivity: function(conv) {
    if (!conv) return new Date(0);
    
    // Start with this conversation's lastModified or timestamp
    let mostRecent = new Date(conv.lastModified || conv.timestamp || 0);
    
    // Check all descendants recursively
    if (conv.children && conv.children.length > 0) {
      conv.children.forEach(childId => {
        const child = this.conversations[childId];
        if (child) {
          const childRecent = this.getMostRecentActivity(child);
          if (childRecent > mostRecent) {
            mostRecent = childRecent;
          }
        }
      });
    }
    
    return mostRecent;
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
    
    // Sort by: 1) current conversation first, 2) most recent activity (including descendants)
    roots.sort((a, b) => {
      // Current conversation always first
      if (a.id === this.currentConversationId) return -1;
      if (b.id === this.currentConversationId) return 1;
      
      // Then sort by most recent activity (including descendants)
      const aRecent = this.getMostRecentActivity(a);
      const bRecent = this.getMostRecentActivity(b);
      return bRecent - aRecent;
    });
    
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
          <div class="folder-name-column">
            <span class="folder-toggle">${isExpanded ? '▼' : '▶'}</span>
            <span class="folder-name">${this.escapeHtml(folder.displayName)}</span>
            <span class="folder-count">[${folder.conversationCount}]</span>
          </div>
          <div class="folder-path-column">
            <span class="folder-path">${this.escapeHtml(folder.path)}</span>
            ${folder.isCurrentCwd ? '<span class="folder-badge">current</span>' : ''}
          </div>
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
   * Toggle conversation details panel visibility
   */
  toggleActionButtons: function() {
    this.showConversationDetails = !this.showConversationDetails;
    localStorage.setItem('showConversationDetails', this.showConversationDetails);
    
    // Update button icon
    const icon = document.getElementById('toggle-actions-icon');
    if (icon) {
      icon.textContent = this.showConversationDetails ? '👁️' : '👁️‍🗨️';
    }
    
    // If turning off and details are currently shown, remove them
    if (!this.showConversationDetails) {
      const existingPanel = document.querySelector('.conversation-details-inline');
      if (existingPanel) {
        existingPanel.remove();
      }
    } else if (this.currentConversationId) {
      // If turning on and we have a selected conversation, show its details
      this.displayConversationDetails(this.currentConversationId);
    }
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
    // Show the most recent activity date (including children)
    const mostRecentDate = this.getMostRecentActivity(conv);
    const timeAgo = this.getRelativeTime(mostRecentDate);
    const isCompact = conv.isCompactSummary;
    const isSidechain = conv.isSidechain;
    const isFork = conv.parentId && this.conversations[conv.parentId] ? '└─' : '';
    
    // Determine icon
    let icon = '💬';
    if (conv.isLeafSummary) icon = '📜'; // Historical archive
    else if (conv.parentId) icon = '🔀'; // Fork
    else if (conv.isCompactSummary) icon = '📦'; // Compact summary
    
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
              ${conv.isLeafSummary ? `${messageCount} summaries` : `${messageCount} msgs`} • ${fileSize} • ${timeAgo}
              ${isCompact ? ' 📦' : ''}${isSidechain ? ' 🔀' : ''}
              ${conv.isLeafSummary ? ' <span style="opacity: 0.7; font-style: italic;">(archived history)</span>' : ''}
              ${conv.id === this.currentConversationId ? ' <span class="badge-current">current</span>' : ''}
            </span>
          </div>
          <div class="conversation-actions${conv.id === this.currentConversationId ? ' always-visible' : ''}">
            ${conv.isLeafSummary ? '' : (conv.id === this.currentConversationId ? 
              `<button class="btn btn-xs btn-pinned" title="This conversation is pinned to the current session" disabled>📌</button>` :
              `<button onclick="dashboardConversations.assignConversation('${conv.id}')" 
                      class="btn btn-xs" title="Pin conversation - Marks this as the default conversation for this tmux session. If you restart the Claude loop or start a new one, it will use this conversation. Does NOT affect currently running Claude sessions.">📍</button>`)}
            ${conv.isLeafSummary ? 
              `<button onclick="dashboardConversations.viewHistory('${conv.id}')" 
                      class="btn btn-xs btn-info" title="View historical summaries - These are compacted conversation archives from before Claude's 30-day retention period">📖 View History</button>` :
              `<button onclick="dashboardConversations.resumeConversation('${conv.id}')" 
                      class="btn btn-xs btn-success" title="Resume conversation - Stops any running loop and starts a fresh Claude session with this conversation. Changes to the conversation's working directory and continues from where it left off.">▶️</button>`}
            <button onclick="dashboardConversations.deleteConversation('${conv.id}')" 
                    class="btn btn-xs btn-danger" title="Delete conversation - Moves this conversation file to trash. Can be recovered from ~/.claude/trash/ if needed. Won't affect running sessions.">🗑️</button>
          </div>
        </div>
      </div>
    `;
    
    // Render children if expanded
    if (hasChildren && isExpanded) {
      // Sort children by most recent activity
      const sortedChildren = conv.children
        .map(childId => this.conversations[childId])
        .filter(child => child)
        .sort((a, b) => {
          // Current conversation always first
          if (a.id === this.currentConversationId) return -1;
          if (b.id === this.currentConversationId) return 1;
          
          // Then sort by most recent activity
          const aRecent = this.getMostRecentActivity(a);
          const bRecent = this.getMostRecentActivity(b);
          return bRecent - aRecent;
        });
      
      sortedChildren.forEach(child => {
        html += this.renderConversationNode(child, depth + 1);
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
      
      // Render tree if conversations are loaded but not yet rendered
      if (this.conversationsLoaded && !this.treeRendered) {
        this.renderTree();
        this.treeRendered = true;
      } else if (!this.conversationsLoaded) {
        // If conversations aren't loaded yet (shouldn't happen), load them now
        this.init();
      }
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
      // Get conversation details to extract working directory
      const conv = this.conversations[conversationId];
      let workingDirectory = null;
      
      if (conv) {
        // Use projectRoot as the primary working directory
        if (conv.projectRoot && conv.projectRoot !== 'unknown') {
          workingDirectory = conv.projectRoot;
        } else if (conv.cwd && conv.cwd !== 'unknown') {
          // Fall back to CWD if projectRoot not available
          workingDirectory = conv.cwd;
        } else if (conv.projectPath) {
          // Last resort: use projectPath
          workingDirectory = conv.projectPath;
        }
      }
      
      const response = await dashboardAPI.request('/api/conversation/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          conversationId: conversationId,
          session: window.currentSession || 'claude',
          workingDirectory: workingDirectory
        })
      });
      
      if (response.success) {
        // Success - no notification needed
        this.currentConversationId = conversationId;
        this.renderTree();
        console.log(`Assigned conversation ${conversationId} to ${window.currentSession} with working dir: ${workingDirectory}`);
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
      
      // Get conversation details for working directory
      const conv = this.conversations[conversationId];
      // Use projectRoot for the working directory (where Claude should be started)
      const workingDir = conv.projectRoot || conv.cwd || 'unknown';
      
      if (workingDir && workingDir !== 'unknown') {
        // Update working directory to project root
        if (window.updateWorkingDirectory) {
          window.updateWorkingDirectory(workingDir);
        }
        // Also update the UI display
        const workingDirInput = document.getElementById('working-directory');
        if (workingDirInput) {
          workingDirInput.value = workingDir;
        }
      }
      
      // Start Claude with this conversation
      const response = await dashboardAPI.request('/api/conversation/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          conversationId: conversationId,
          session: window.currentSession || 'claude',
          cwd: workingDir  // Send projectRoot as the working directory
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
   * View history for leaf summary files
   */
  viewHistory: async function(conversationId) {
    try {
      const conv = this.conversations[conversationId];
      if (!conv || !conv.isLeafSummary) {
        alert('This is not a historical summary file');
        return;
      }
      
      // Read the conversation file to get all summaries
      const response = await fetch(`/api/conversation/read?id=${conversationId}`);
      const lines = await response.text();
      
      // Parse summaries
      const summaries = [];
      for (const line of lines.split('\n')) {
        if (line.trim()) {
          try {
            const data = JSON.parse(line);
            if (data.type === 'summary' && data.summary) {
              summaries.push({
                text: data.summary,
                leafUuid: data.leafUuid || 'unknown'
              });
            }
          } catch (e) {
            // Skip invalid lines
          }
        }
      }
      
      // Create modal to display summaries
      const modalHtml = `
        <div style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 9999; display: flex; align-items: center; justify-content: center;">
          <div style="background: white; border-radius: 8px; padding: 20px; max-width: 800px; max-height: 80vh; overflow-y: auto; position: relative;">
            <button onclick="this.parentElement.parentElement.remove()" style="position: absolute; top: 10px; right: 10px; background: none; border: none; font-size: 24px; cursor: pointer;">×</button>
            <h2 style="margin-top: 0;">📜 Historical Summaries</h2>
            <p style="color: #666;">These are compacted conversation archives from before Claude's 30-day retention period.</p>
            <p style="color: #d9534f;">⚠️ The referenced conversations have been deleted and cannot be resumed.</p>
            <hr>
            ${summaries.map((s, i) => `
              <div style="margin-bottom: 15px; padding: 10px; background: #f5f5f5; border-radius: 4px;">
                <strong>Summary ${i + 1}:</strong><br>
                ${s.text}<br>
                <small style="color: #999;">Points to: ${s.leafUuid.substring(0, 8)}...</small>
              </div>
            `).join('')}
            ${summaries.length === 0 ? '<p>No summaries found in this file.</p>' : ''}
          </div>
        </div>
      `;
      
      // Add modal to page
      const modal = document.createElement('div');
      modal.innerHTML = modalHtml;
      document.body.appendChild(modal.firstElementChild);
      
    } catch (error) {
      console.error('Failed to view history:', error);
      alert('Failed to load historical summaries: ' + error.message);
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
      const response = await dashboardAPI.request('/api/conversation/name', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          conversationId: conversationId,
          name: newName
        })
      });
      
      if (response.success || response.name) {
        // Update local data - the API returns the name
        if (this.conversations[conversationId]) {
          this.conversations[conversationId].customName = newName;
        }
        
        // The name is now saved in conversation-names.json on the server
        // It will be loaded on next page refresh
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