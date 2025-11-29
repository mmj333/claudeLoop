#!/usr/bin/env node

/**
 * Dashboard Conditional Messaging Module
 * Handles time-based and context-based conditional messages
 */

const dashboardConditional = {
  // Default configuration
  defaultConfig: {
    morningMessage: {
      enabled: false,
      startHour: 6,
      endHour: 12,
      message: "Good morning! Please continue with the project. Focus on high-priority tasks first."
    },
    afternoonMessage: {
      enabled: false,
      startHour: 12,
      endHour: 18,
      message: "Good afternoon! Please continue. Consider reviewing and testing recent changes."
    },
    eveningMessage: {
      enabled: false,
      startHour: 18,
      endHour: 24,
      message: "Good evening! Please continue. Focus on documentation and cleanup tasks."
    },
    standardMessage: {
      enabled: false,
      message: "Please continue with the current task."
    },
    lowContextMessage: {
      enabled: false,
      threshold: 20,
      message: "Context is getting low. Consider wrapping up or using /compact.",
      autoCompact: false,
      autoFinish: false
    },
    afterCompactMessage: {
      enabled: false,
      linesAfterCompact: 5,
      message: "Thanks for compacting! Here's what we were working on: {summary}"
    }
  },

  /**
   * Initialize the conditional messaging module
   */
  init: function() {
    // Load saved config if available
    if (window.loopConfig && window.loopConfig.conditionalMessages) {
      this.config = { ...this.defaultConfig, ...window.loopConfig.conditionalMessages };
    } else {
      this.config = { ...this.defaultConfig };
    }

    // Initialize UI if present
    if (document.getElementById('conditional-card')) {
      this.initializeUI();
      this.loadConfigIntoUI();
    }
  },

  /**
   * Initialize the UI components
   */
  initializeUI: function() {
    const card = document.getElementById('conditional-card');
    if (!card) return;

    // Create the UI structure
    const content = document.getElementById('conditional-content');
    if (!content) return;

    let html = `
      <div class="conditional-messages">
        <!-- Time-Based Messages -->
        <h4 style="margin: 10px 0;">Time-Based Messages</h4>
        
        <!-- Morning Message -->
        <div class="control-group" style="background: var(--bg-tertiary); padding: 15px; border-radius: 6px; margin-bottom: 10px;">
          <div class="checkbox-group">
            <label style="cursor: pointer;" onclick="dashboardConditional.toggleSection('morning', event)">
              <input type="checkbox" id="morning-enabled" onchange="dashboardConditional.updateConfig()">
              <span id="morning-arrow" style="display: inline-block; width: 12px;">▶</span>
              Morning
            </label>
          </div>
          <div id="morning-settings" style="display: none; margin-left: 20px;">
            <div style="display: flex; gap: 10px; align-items: center; margin: 10px 0;">
              <label style="font-size: 12px;">From</label>
              <input type="number" id="morning-start" min="0" max="23" value="6" style="width: 50px;" onchange="dashboardConditional.updateConfig()">
              <label style="font-size: 12px;">to</label>
              <input type="number" id="morning-end" min="0" max="23" value="12" style="width: 50px;" onchange="dashboardConditional.updateConfig()">
            </div>
            <textarea id="morning-message" class="auto-resize" placeholder="Good morning! Please continue with the project. Focus on high-priority tasks first." onchange="dashboardConditional.updateConfig()"></textarea>
          </div>
        </div>

        <!-- Afternoon Message -->
        <div class="control-group" style="background: var(--bg-tertiary); padding: 15px; border-radius: 6px; margin-bottom: 10px;">
          <div class="checkbox-group">
            <label style="cursor: pointer;" onclick="dashboardConditional.toggleSection('afternoon', event)">
              <input type="checkbox" id="afternoon-enabled" onchange="dashboardConditional.updateConfig()">
              <span id="afternoon-arrow" style="display: inline-block; width: 12px;">▶</span>
              Afternoon
            </label>
          </div>
          <div id="afternoon-settings" style="display: none; margin-left: 20px;">
            <div style="display: flex; gap: 10px; align-items: center; margin: 10px 0;">
              <label style="font-size: 12px;">From</label>
              <input type="number" id="afternoon-start" min="0" max="23" value="12" style="width: 50px;" onchange="dashboardConditional.updateConfig()">
              <label style="font-size: 12px;">to</label>
              <input type="number" id="afternoon-end" min="0" max="23" value="18" style="width: 50px;" onchange="dashboardConditional.updateConfig()">
            </div>
            <textarea id="afternoon-message" class="auto-resize" placeholder="Good afternoon! Please continue. Consider reviewing and testing recent changes." onchange="dashboardConditional.updateConfig()"></textarea>
          </div>
        </div>

        <!-- Evening Message -->
        <div class="control-group" style="background: var(--bg-tertiary); padding: 15px; border-radius: 6px; margin-bottom: 10px;">
          <div class="checkbox-group">
            <label style="cursor: pointer;" onclick="dashboardConditional.toggleSection('evening', event)">
              <input type="checkbox" id="evening-enabled" onchange="dashboardConditional.updateConfig()">
              <span id="evening-arrow" style="display: inline-block; width: 12px;">▶</span>
              Evening
            </label>
          </div>
          <div id="evening-settings" style="display: none; margin-left: 20px;">
            <div style="display: flex; gap: 10px; align-items: center; margin: 10px 0;">
              <label style="font-size: 12px;">From</label>
              <input type="number" id="evening-start" min="0" max="23" value="18" style="width: 50px;" onchange="dashboardConditional.updateConfig()">
              <label style="font-size: 12px;">to</label>
              <input type="number" id="evening-end" min="0" max="23" value="23" style="width: 50px;" onchange="dashboardConditional.updateConfig()">
            </div>
            <textarea id="evening-message" class="auto-resize" placeholder="Good evening! Please continue. Focus on documentation and cleanup tasks." onchange="dashboardConditional.updateConfig()"></textarea>
          </div>
        </div>

        <!-- Standard Message -->
        <div class="control-group" style="background: var(--bg-tertiary); padding: 15px; border-radius: 6px; margin-bottom: 10px;">
          <div class="checkbox-group">
            <label style="cursor: pointer;" onclick="dashboardConditional.toggleSection('standard', event)">
              <input type="checkbox" id="standard-enabled" onchange="dashboardConditional.updateConfig()">
              <span id="standard-arrow" style="display: inline-block; width: 12px;">▶</span>
              Standard Message (all other times)
            </label>
          </div>
          <div id="standard-settings" style="display: none; margin-left: 20px;">
            <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 5px;">
              This message will be used when no time-specific messages apply
            </div>
            <textarea id="standard-message" class="auto-resize" placeholder="Please continue with the current task..." onchange="dashboardConditional.updateConfig()"></textarea>
          </div>
        </div>

        <h4 style="margin: 10px 0;">Context-Based Messages</h4>

        <!-- Low Context Message -->
        <div class="control-group" style="background: var(--bg-tertiary); padding: 15px; border-radius: 6px; margin-bottom: 10px;">
          <div class="checkbox-group">
            <label>
              <input type="checkbox" id="low-context-enabled" checked onchange="dashboardConditional.updateConfig()">
              Low Context Warning
            </label>
          </div>
          <div id="low-context-settings" style="margin-left: 20px;">
            <label style="font-size: 12px;">Threshold %</label>
            <input type="number" id="low-context-threshold" min="10" max="50" value="30" style="width: 60px;" onchange="dashboardConditional.updateConfig()">
            <textarea id="low-context-message" class="auto-resize" style="margin-top: 5px;" placeholder="Context is getting low. Consider wrapping up or using /compact." onchange="dashboardConditional.updateConfig()"></textarea>
            
            <div class="checkbox-group" style="margin-top: 10px;">
              <label>
                <input type="checkbox" id="auto-compact-enabled" onchange="dashboardConditional.updateConfig()">
                Enable Auto-Compact (adds instruction for Claude to say "Let's compact!")
              </label>
              <label style="display: block; margin-top: 8px;">
                <input type="checkbox" id="auto-finish-enabled" onchange="dashboardConditional.updateConfig()">
                Enable Auto-Finish (adds instruction for Claude to say "Finished everything for now!")
              </label>
            </div>
          </div>
        </div>

        <!-- After Compact Message -->
        <div class="control-group" style="background: var(--bg-tertiary); padding: 15px; border-radius: 6px; margin-bottom: 10px;">
          <div class="checkbox-group">
            <label>
              <input type="checkbox" id="after-compact-enabled" checked onchange="dashboardConditional.updateConfig()">
              After Compact Message
            </label>
          </div>
          <div id="after-compact-settings" style="margin-left: 20px;">
            <label style="font-size: 12px;">Lines after compact</label>
            <input type="number" id="after-compact-lines" min="10" max="100" value="50" style="width: 60px;" onchange="dashboardConditional.updateConfig()">
            <textarea id="after-compact-message" class="auto-resize" style="margin-top: 5px;" placeholder="Thanks for compacting! Here's what we were working on: {summary}" onchange="dashboardConditional.updateConfig()"></textarea>
          </div>
        </div>

        <div style="color: var(--text-secondary); font-size: 12px; margin-top: 20px; text-align: center;">
          ✨ Settings auto-save as you type
        </div>
        
        <!-- Active Message Preview -->
        <div style="margin-top: 20px; padding: 15px; background: var(--bg-tertiary); border-radius: 6px;">
          <h4 style="margin: 0 0 10px 0;">🎯 Currently Active Message</h4>
          <div id="active-message-preview" style="color: var(--text-secondary); font-style: italic;">
            Loading...
          </div>
        </div>
      </div>
    `;

    content.innerHTML = html;

    // Start monitoring for active messages
    this.startMonitoring();
  },

  /**
   * Toggle a settings section
   */
  toggleSection: function(section, event) {
    // Prevent the checkbox from toggling when clicking the label
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    
    const settings = document.getElementById(`${section}-settings`);
    const arrow = document.getElementById(`${section}-arrow`);
    const checkbox = document.getElementById(`${section}-enabled`);
    
    if (settings && arrow) {
      if (checkbox && checkbox.checked) {
        // If checkbox is checked, show the settings
        settings.style.display = 'block';
        arrow.textContent = '▼';
      } else {
        // Toggle visibility
        if (settings.style.display === 'none') {
          settings.style.display = 'block';
          arrow.textContent = '▼';
        } else {
          settings.style.display = 'none';
          arrow.textContent = '▶';
        }
      }
    }
  },

  /**
   * Load configuration into UI
   */
  loadConfigIntoUI: function() {
    // Morning message
    const morningEnabled = document.getElementById('morning-enabled');
    if (morningEnabled) {
      morningEnabled.checked = this.config.morningMessage.enabled;
      document.getElementById('morning-start').value = this.config.morningMessage.startHour;
      document.getElementById('morning-end').value = this.config.morningMessage.endHour;
      document.getElementById('morning-message').value = this.config.morningMessage.message;
    }

    // Afternoon message
    const afternoonEnabled = document.getElementById('afternoon-enabled');
    if (afternoonEnabled) {
      afternoonEnabled.checked = this.config.afternoonMessage.enabled;
      document.getElementById('afternoon-start').value = this.config.afternoonMessage.startHour;
      document.getElementById('afternoon-end').value = this.config.afternoonMessage.endHour;
      document.getElementById('afternoon-message').value = this.config.afternoonMessage.message;
    }

    // Evening message
    const eveningEnabled = document.getElementById('evening-enabled');
    if (eveningEnabled) {
      eveningEnabled.checked = this.config.eveningMessage.enabled;
      document.getElementById('evening-start').value = this.config.eveningMessage.startHour;
      document.getElementById('evening-end').value = this.config.eveningMessage.endHour;
      document.getElementById('evening-message').value = this.config.eveningMessage.message;
    }

    // Standard message
    const standardEnabled = document.getElementById('standard-enabled');
    if (standardEnabled) {
      standardEnabled.checked = this.config.standardMessage?.enabled || false;
      document.getElementById('standard-message').value = this.config.standardMessage?.message || '';
    }

    // Low context message
    const lowContextEnabled = document.getElementById('low-context-enabled');
    if (lowContextEnabled) {
      lowContextEnabled.checked = this.config.lowContextMessage.enabled;
      document.getElementById('low-context-threshold').value = this.config.lowContextMessage.threshold;
      document.getElementById('low-context-message').value = this.config.lowContextMessage.message;
      document.getElementById('auto-compact-enabled').checked = this.config.lowContextMessage.autoCompact;
      document.getElementById('auto-finish-enabled').checked = this.config.lowContextMessage.autoFinish;
    }

    // After compact message
    const afterCompactEnabled = document.getElementById('after-compact-enabled');
    if (afterCompactEnabled) {
      afterCompactEnabled.checked = this.config.afterCompactMessage.enabled;
      document.getElementById('after-compact-lines').value = this.config.afterCompactMessage.linesAfterCompact;
      document.getElementById('after-compact-message').value = this.config.afterCompactMessage.message;
    }
  },

  /**
   * Update configuration from UI
   */
  updateConfig: function() {
    // Morning message
    this.config.morningMessage.enabled = document.getElementById('morning-enabled')?.checked || false;
    this.config.morningMessage.startHour = parseInt(document.getElementById('morning-start')?.value || 6);
    this.config.morningMessage.endHour = parseInt(document.getElementById('morning-end')?.value || 12);
    this.config.morningMessage.message = document.getElementById('morning-message')?.value || this.defaultConfig.morningMessage.message;

    // Afternoon message
    this.config.afternoonMessage.enabled = document.getElementById('afternoon-enabled')?.checked || false;
    this.config.afternoonMessage.startHour = parseInt(document.getElementById('afternoon-start')?.value || 12);
    this.config.afternoonMessage.endHour = parseInt(document.getElementById('afternoon-end')?.value || 18);
    this.config.afternoonMessage.message = document.getElementById('afternoon-message')?.value || this.defaultConfig.afternoonMessage.message;

    // Evening message
    this.config.eveningMessage.enabled = document.getElementById('evening-enabled')?.checked || false;
    this.config.eveningMessage.startHour = parseInt(document.getElementById('evening-start')?.value || 18);
    this.config.eveningMessage.endHour = parseInt(document.getElementById('evening-end')?.value || 24);
    this.config.eveningMessage.message = document.getElementById('evening-message')?.value || this.defaultConfig.eveningMessage.message;

    // Standard message
    this.config.standardMessage = this.config.standardMessage || {};
    this.config.standardMessage.enabled = document.getElementById('standard-enabled')?.checked || false;
    this.config.standardMessage.message = document.getElementById('standard-message')?.value || this.defaultConfig.standardMessage?.message || '';

    // Low context message
    this.config.lowContextMessage.enabled = document.getElementById('low-context-enabled')?.checked || false;
    this.config.lowContextMessage.threshold = parseInt(document.getElementById('low-context-threshold')?.value || 20);
    this.config.lowContextMessage.message = document.getElementById('low-context-message')?.value || this.defaultConfig.lowContextMessage.message;
    this.config.lowContextMessage.autoCompact = document.getElementById('auto-compact-enabled')?.checked || false;
    this.config.lowContextMessage.autoFinish = document.getElementById('auto-finish-enabled')?.checked || false;

    // After compact message
    this.config.afterCompactMessage.enabled = document.getElementById('after-compact-enabled')?.checked || false;
    this.config.afterCompactMessage.linesAfterCompact = parseInt(document.getElementById('after-compact-lines')?.value || 5);
    this.config.afterCompactMessage.message = document.getElementById('after-compact-message')?.value || this.defaultConfig.afterCompactMessage.message;

    // Save to global config
    if (window.loopConfig) {
      window.loopConfig.conditionalMessages = this.config;
      if (window.saveConfig) {
        window.saveConfig();
      }
    }

    // Update preview
    this.updateActiveMessagePreview();
  },

  /**
   * Get the currently active message based on conditions
   */
  getActiveMessage: function(contextPercent, linesAfterCompact) {
    const hour = new Date().getHours();

    // Check after compact message first (highest priority)
    if (this.config.afterCompactMessage.enabled && 
        linesAfterCompact !== undefined && 
        linesAfterCompact <= this.config.afterCompactMessage.linesAfterCompact) {
      return {
        type: 'afterCompact',
        message: this.config.afterCompactMessage.message
      };
    }

    // Check low context message
    if (this.config.lowContextMessage.enabled && 
        contextPercent !== undefined &&
        contextPercent <= this.config.lowContextMessage.threshold) {
      return {
        type: 'lowContext',
        message: this.config.lowContextMessage.message,
        autoCompact: this.config.lowContextMessage.autoCompact,
        autoFinish: this.config.lowContextMessage.autoFinish
      };
    }

    // Check time-based messages
    if (this.config.morningMessage.enabled && 
        hour >= this.config.morningMessage.startHour && 
        hour < this.config.morningMessage.endHour) {
      return {
        type: 'morning',
        message: this.config.morningMessage.message
      };
    }

    if (this.config.afternoonMessage.enabled && 
        hour >= this.config.afternoonMessage.startHour && 
        hour < this.config.afternoonMessage.endHour) {
      return {
        type: 'afternoon',
        message: this.config.afternoonMessage.message
      };
    }

    if (this.config.eveningMessage.enabled && 
        hour >= this.config.eveningMessage.startHour && 
        hour < this.config.eveningMessage.endHour) {
      return {
        type: 'evening',
        message: this.config.eveningMessage.message
      };
    }

    // Check standard message (fallback for other times)
    if (this.config.standardMessage?.enabled) {
      return {
        type: 'standard',
        message: this.config.standardMessage.message
      };
    }

    return null;
  },

  /**
   * Update the active message preview
   */
  updateActiveMessagePreview: async function() {
    const preview = document.getElementById('active-message-preview');
    if (!preview) return;

    try {
      // Fetch the active message from the server
      if (window.dashboardAPI && window.dashboardAPI.getActiveConditionalMessage) {
        const activeMessage = await window.dashboardAPI.getActiveConditionalMessage(window.currentSession || 'claude');
        
        if (activeMessage && activeMessage.type !== 'none') {
          let html = `
            <div class="active-message">
              <div style="margin-bottom: 10px;">
                <span style="display: inline-block; padding: 2px 8px; background: var(--primary); color: white; border-radius: 3px; font-size: 11px; text-transform: uppercase;">
                  ${activeMessage.type}
                </span>
                <span style="color: var(--text-secondary); font-size: 11px; margin-left: 10px;">
                  Priority: ${activeMessage.priority || 'N/A'}
                </span>
              </div>
              <div style="padding: 10px; background: var(--bg-secondary); border-radius: 4px; white-space: pre-wrap; color: var(--text-primary); font-style: normal;">
                ${activeMessage.message}
              </div>
          `;
          
          if (activeMessage.autoCompact || activeMessage.autoFinish) {
            html += '<div style="margin-top: 10px;">';
            if (activeMessage.autoCompact) {
              html += '<span style="display: inline-block; padding: 2px 6px; background: var(--info); color: white; border-radius: 3px; font-size: 10px; margin-right: 5px;">AUTO-COMPACT</span>';
            }
            if (activeMessage.autoFinish) {
              html += '<span style="display: inline-block; padding: 2px 6px; background: var(--warning); color: white; border-radius: 3px; font-size: 10px;">AUTO-FINISH</span>';
            }
            html += '</div>';
          }
          
          html += '</div>';
          preview.innerHTML = html;
        } else {
          // Fallback to local calculation
          const contextText = document.getElementById('context-text')?.textContent;
          const contextPercent = contextText ? parseInt(contextText) : 100;
          const localMessage = this.getActiveMessage(contextPercent);
          
          if (localMessage) {
            preview.innerHTML = `
              <div class="active-message">
                <strong>Type:</strong> ${localMessage.type}<br>
                <strong>Message:</strong> ${localMessage.message}
              </div>
            `;
          } else {
            preview.innerHTML = '<em style="color: var(--text-secondary);">No conditional messages are currently active</em>';
          }
        }
      }
    } catch (error) {
      console.error('Failed to fetch active message:', error);
      preview.innerHTML = '<em style="color: var(--danger);">Failed to fetch active message</em>';
    }
  },

  /**
   * Start monitoring for active messages
   */
  startMonitoring: function() {
    // Update preview every 30 seconds
    setInterval(() => {
      this.updateActiveMessagePreview();
    }, 30000);

    // Initial update
    this.updateActiveMessagePreview();
  },

  /**
   * Toggle the conditional messages card
   */
  toggleCard: function() {
    const card = document.getElementById('conditional-card');
    const content = document.getElementById('conditional-content');
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
  }
};

// Export for Node.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = dashboardConditional;
}

// Make available globally in browser
if (typeof window !== 'undefined') {
  window.dashboardConditional = dashboardConditional;
}