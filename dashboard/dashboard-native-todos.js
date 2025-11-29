#!/usr/bin/env node

/**
 * Dashboard Native Todos Module
 * Displays Claude's native todos for the selected conversation
 */

window.dashboardNativeTodos = {
  // State
  currentConversationId: null,
  nativeTodos: [],
  autoRefreshInterval: null,
  
  /**
   * Initialize the native todos module
   */
  init: function() {
    console.log('Native todos module initialized');
    
    // Listen for conversation selection changes
    if (window.dashboardConversations) {
      const originalSelect = window.dashboardConversations.selectConversation;
      window.dashboardConversations.selectConversation = function(conversationId) {
        originalSelect.call(window.dashboardConversations, conversationId);
        window.dashboardNativeTodos.loadForConversation(conversationId);
      };
    }
    
    // Start auto-refresh
    this.startAutoRefresh();
  },
  
  /**
   * Toggle the native todos panel visibility
   */
  togglePanel: function() {
    const content = document.getElementById('native-todos-content');
    const toggle = document.getElementById('native-todo-toggle');

    if (content.style.display === 'none') {
      content.style.display = 'block';
      toggle.textContent = '▼';
      // Refresh when opening
      if (this.currentConversationId) {
        this.loadForConversation(this.currentConversationId);
      }
    } else {
      content.style.display = 'none';
      toggle.textContent = '▶';
    }
  },

  /**
   * Manually refresh the native todos
   */
  refresh: async function() {
    if (!this.currentConversationId) {
      alert('Please select a conversation first');
      return;
    }

    // Visual feedback - spin the button
    const btn = document.getElementById('native-todo-refresh-btn');
    if (btn) {
      btn.style.animation = 'spin 0.5s linear';
      btn.disabled = true;
    }

    // Reload todos
    await this.loadForConversation(this.currentConversationId);

    // Reset button
    if (btn) {
      setTimeout(() => {
        btn.style.animation = '';
        btn.disabled = false;
      }, 500);
    }
  },
  
  /**
   * Load native todos for a specific conversation
   */
  loadForConversation: async function(conversationId) {
    this.currentConversationId = conversationId;
    
    if (!conversationId) {
      this.renderEmpty('Select a conversation to view Claude\'s tasks');
      return;
    }
    
    try {
      const response = await fetch(`/api/todos/claude-native/${conversationId}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      this.nativeTodos = await response.json();
      this.render();
      
      // Also highlight any linked dashboard todos
      this.highlightLinkedTodos();
      
    } catch (error) {
      console.error('Failed to load native todos:', error);
      this.renderError();
    }
  },
  
  /**
   * Render the native todos
   */
  render: function() {
    const container = document.getElementById('native-todo-list');
    const countBadge = document.getElementById('native-todo-count');
    const sessionLabel = document.getElementById('native-todo-session');
    
    // Update session label
    if (this.currentConversationId) {
      const sessionDisplay = this.currentConversationId.length > 20 ? 
        this.currentConversationId.substring(0, 8) + '...' : 
        this.currentConversationId;
      sessionLabel.textContent = `(${sessionDisplay})`;
    }
    
    // No todos
    if (!this.nativeTodos || this.nativeTodos.length === 0) {
      this.renderEmpty('No active tasks for this session');
      return;
    }
    
    // Update count
    const activeTodos = this.nativeTodos.filter(t => t.status !== 'completed');
    countBadge.textContent = activeTodos.length || this.nativeTodos.length;
    countBadge.style.display = 'inline-block';
    
    // Build HTML
    let html = '<div style="display: flex; flex-direction: column; gap: 4px;">';
    
    this.nativeTodos.forEach(todo => {
      const isCompleted = todo.status === 'completed';
      const statusClass = isCompleted ? 'text-decoration: line-through; opacity: 0.6;' : '';
      const statusBadge = todo.status === 'in_progress' ? '🔄' : 
                         todo.status === 'completed' ? '✅' : '⏳';
      
      // Check if linked to dashboard
      const dashboardLink = todo.dashboardId ? 
        this.findDashboardTodo(todo.dashboardId) : null;
      
      html += `
        <div style="padding: 5px; background: var(--bg-secondary); border-radius: 4px;
                    border-left: 3px solid ${isCompleted ? 'var(--success)' : 'var(--primary)'};"
                    data-todo-id="${todo.id}">
          <div style="display: flex; align-items: start; gap: 4px;">
            <span title="${todo.status}">${statusBadge}</span>
            <div style="flex: 1;">
              <div class="todo-content-display" id="content-display-${todo.id}"
                   style="${statusClass} cursor: pointer;"
                   ondblclick="dashboardNativeTodos.startEdit('${todo.id}')"
                   title="Double-click to edit">${this.escapeHtml(todo.content)}</div>
              <div class="todo-content-edit" id="content-edit-${todo.id}" style="display: none; margin-top: 4px;">
                <input type="text" id="edit-input-${todo.id}"
                       value="${this.escapeHtml(todo.content).replace(/"/g, '&quot;')}"
                       style="width: 100%; padding: 4px; border: 1px solid var(--border-color); border-radius: 4px; font-size: 12px;">
                <div style="display: flex; gap: 4px; margin-top: 4px;">
                  <button onclick="dashboardNativeTodos.saveEdit('${todo.id}')" class="btn btn-xs">💾 Save</button>
                  <button onclick="dashboardNativeTodos.cancelEdit('${todo.id}')" class="btn btn-xs">✖ Cancel</button>
                </div>
              </div>
              
              ${dashboardLink ? `
                <div style="font-size: 10px; color: var(--text-secondary); margin-top: 4px;">
                  📋 Dashboard: <span style="color: var(--primary); cursor: pointer;" 
                       onclick="dashboardNativeTodos.scrollToDashboardTodo('${todo.dashboardId}')">
                    ${this.escapeHtml(dashboardLink.text ? dashboardLink.text.substring(0, 50) + '...' : 'View')}
                  </span>
                </div>` : ''}
              
              ${todo.priority && todo.priority !== 'normal' ? `
                <span style="font-size: 10px; padding: 2px 4px; background: ${
                  todo.priority === 'high' ? 'var(--danger)' : 'var(--warning)'
                }; color: white; border-radius: 3px; margin-left: 4px;">
                  ${todo.priority}
                </span>` : ''}
              
              ${todo.claimedAt ? `
                <div style="font-size: 10px; color: var(--text-secondary); margin-top: 2px;">
                  ⏰ Claimed: ${this.getRelativeTime(todo.claimedAt)}
                </div>` : ''}
            </div>

            <div style="display: flex; flex-direction: row; gap: 2px;">
              <button onclick="dashboardNativeTodos.startEdit('${todo.id}')"
                      class="btn btn-xs" style="padding: 2px 4px;"
                      title="Edit task">
                ✏️
              </button>
              ${isCompleted ? `
                <button onclick="dashboardNativeTodos.markIncomplete('${todo.id}')"
                        class="btn btn-xs" style="padding: 2px 4px;"
                        title="Mark as incomplete">
                  ↩️
                </button>` : `
                <button onclick="dashboardNativeTodos.markComplete('${todo.id}')"
                        class="btn btn-xs" style="padding: 2px 4px;"
                        title="Mark as complete">
                  ✓
                </button>`}
            </div>
          </div>
        </div>
      `;
    });
    
    html += '</div>';
    container.innerHTML = html;
  },
  
  /**
   * Render empty state
   */
  renderEmpty: function(message) {
    document.getElementById('native-todo-list').innerHTML = 
      `<div style="color: var(--text-secondary); font-style: italic;">${message}</div>`;
    document.getElementById('native-todo-session').textContent = '';
    document.getElementById('native-todo-count').style.display = 'none';
  },
  
  /**
   * Render error state
   */
  renderError: function() {
    this.renderEmpty('Failed to load tasks');
  },
  
  /**
   * Find a dashboard todo by ID
   */
  findDashboardTodo: function(dashboardId) {
    // Access global todos array if available
    if (window.todos) {
      return window.todos.find(t => t.id === dashboardId);
    }
    return null;
  },
  
  /**
   * Highlight linked todos in the dashboard
   */
  highlightLinkedTodos: function() {
    if (!this.nativeTodos || !window.todos) return;
    
    // Clear previous highlights
    document.querySelectorAll('.todo-item').forEach(item => {
      item.classList.remove('native-linked');
    });
    
    // Add highlights for linked todos
    this.nativeTodos.forEach(nativeTodo => {
      if (nativeTodo.dashboardId) {
        const todoElement = document.querySelector(`[data-todo-id="${nativeTodo.dashboardId}"]`);
        if (todoElement) {
          todoElement.classList.add('native-linked');
          // Add a small indicator
          if (!todoElement.querySelector('.native-indicator')) {
            const indicator = document.createElement('span');
            indicator.className = 'native-indicator';
            indicator.textContent = '🤖';
            indicator.style.cssText = 'margin-left: 4px; font-size: 10px;';
            indicator.title = 'Claimed by Claude';
            todoElement.querySelector('.todo-text')?.appendChild(indicator);
          }
        }
      }
    });
  },
  
  /**
   * Scroll to a dashboard todo
   */
  scrollToDashboardTodo: function(todoId) {
    const todoElement = document.querySelector(`[data-todo-id="${todoId}"]`);
    if (todoElement) {
      todoElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Flash highlight
      todoElement.style.background = 'var(--primary-light)';
      setTimeout(() => {
        todoElement.style.background = '';
      }, 1000);
    }
  },
  
  /**
   * Mark a native todo as complete
   */
  markComplete: async function(todoId) {
    const todo = this.nativeTodos.find(t => t.id === todoId);
    if (!todo) return;

    // Update locally first for immediate feedback
    todo.status = 'completed';
    this.render();

    // Save to file
    await this.saveTodos();
  },

  /**
   * Mark a native todo as incomplete
   */
  markIncomplete: async function(todoId) {
    const todo = this.nativeTodos.find(t => t.id === todoId);
    if (!todo) return;

    // Update locally first for immediate feedback
    todo.status = 'pending';
    this.render();

    // Save to file
    await this.saveTodos();
  },

  /**
   * Start editing a todo
   */
  startEdit: function(todoId) {
    // Hide display, show edit
    const display = document.getElementById(`content-display-${todoId}`);
    const edit = document.getElementById(`content-edit-${todoId}`);
    const input = document.getElementById(`edit-input-${todoId}`);

    if (display) display.style.display = 'none';
    if (edit) edit.style.display = 'block';
    if (input) {
      input.focus();
      input.select();
    }
  },

  /**
   * Save edited todo
   */
  saveEdit: async function(todoId) {
    const input = document.getElementById(`edit-input-${todoId}`);
    if (!input) return;

    const newContent = input.value.trim();
    if (!newContent) {
      alert('Task content cannot be empty');
      return;
    }

    // Find and update todo
    const todo = this.nativeTodos.find(t => t.id === todoId);
    if (todo) {
      todo.content = newContent;
      todo.activeForm = newContent;

      // Save to file
      await this.saveTodos();

      // Re-render to show changes
      this.render();
    }
  },

  /**
   * Cancel editing
   */
  cancelEdit: function(todoId) {
    // Hide edit, show display
    const display = document.getElementById(`content-display-${todoId}`);
    const edit = document.getElementById(`content-edit-${todoId}`);

    if (display) display.style.display = 'block';
    if (edit) edit.style.display = 'none';
  },

  /**
   * Add a new task
   */
  addTask: async function(content) {
    if (!content) {
      const input = document.getElementById('native-todo-input');
      content = input?.value?.trim();
      if (!content) return;

      // Clear input
      input.value = '';
    }

    if (!this.currentConversationId) {
      alert('Please select a conversation first');
      return;
    }

    // Create new todo
    const newTodo = {
      id: Date.now().toString(),
      content: content,
      status: 'pending',
      activeForm: content
    };

    // Add to local array
    this.nativeTodos.push(newTodo);
    this.render();

    // Save to file
    await this.saveTodos();
  },

  /**
   * Save todos to file via API
   */
  saveTodos: async function() {
    if (!this.currentConversationId) return;

    try {
      const response = await fetch(`/api/todos/claude-native/${this.currentConversationId}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.nativeTodos)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      console.log('Saved native todos for conversation:', this.currentConversationId);
    } catch (error) {
      console.error('Failed to save native todos:', error);
      alert('Failed to save task: ' + error.message);
    }
  },
  
  /**
   * Get relative time string
   */
  getRelativeTime: function(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  },
  
  /**
   * Escape HTML for safe display
   */
  escapeHtml: function(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },
  
  /**
   * Start auto-refresh
   */
  startAutoRefresh: function() {
    // Refresh every 30 seconds if panel is visible
    this.autoRefreshInterval = setInterval(() => {
      const content = document.getElementById('native-todos-content');
      if (content && content.style.display !== 'none' && this.currentConversationId) {
        this.loadForConversation(this.currentConversationId);
      }
    }, 30000);
  },
  
  /**
   * Stop auto-refresh
   */
  stopAutoRefresh: function() {
    if (this.autoRefreshInterval) {
      clearInterval(this.autoRefreshInterval);
      this.autoRefreshInterval = null;
    }
  }
};

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.dashboardNativeTodos.init();
  });
} else {
  // DOM already loaded
  setTimeout(() => window.dashboardNativeTodos.init(), 100);
}