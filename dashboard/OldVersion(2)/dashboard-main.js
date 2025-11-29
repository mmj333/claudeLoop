/**
 * Main Dashboard JavaScript
 * Handles all dashboard functionality
 */

// Global state
let currentSession = 'claude';
let selectedConversation = null;
let autoScrollConsole = true;
let autoScrollChat = true;

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
  await initialize();
  
  // Setup dark mode toggle
  const darkModeToggle = document.getElementById('toggle-dark-mode');
  if (darkModeToggle) {
    darkModeToggle.addEventListener('click', toggleDarkMode);
  }
  
  // Load initial data
  await loadSessions();
  await updateStatus();
  await loadConfig();
  
  // Start periodic updates
  setInterval(updateStatus, 5000);
  setInterval(updateContext, 10000);
  
  // Load initial tab
  switchTab('control');
});

// Initialize dashboard
async function initialize() {
  console.log('Initializing dashboard...');
  
  // Check for saved dark mode preference
  const savedDarkMode = localStorage.getItem('darkMode');
  if (savedDarkMode === 'true') {
    document.body.classList.add('dark-mode');
  }
  
  // Setup auto-scroll checkboxes
  const autoScrollCheckbox = document.getElementById('auto-scroll');
  if (autoScrollCheckbox) {
    autoScrollCheckbox.checked = autoScrollConsole;
    autoScrollCheckbox.addEventListener('change', (e) => {
      autoScrollConsole = e.target.checked;
    });
  }
  
  const chatAutoScrollCheckbox = document.getElementById('chat-auto-scroll');
  if (chatAutoScrollCheckbox) {
    chatAutoScrollCheckbox.checked = autoScrollChat;
    chatAutoScrollCheckbox.addEventListener('change', (e) => {
      autoScrollChat = e.target.checked;
    });
  }
  
  // Setup form submissions
  const configForm = document.getElementById('config-form');
  if (configForm) {
    configForm.addEventListener('submit', saveConfig);
  }
  
  const scheduleForm = document.getElementById('schedule-form');
  if (scheduleForm) {
    scheduleForm.addEventListener('submit', saveSchedule);
  }
}

// Tab switching
function switchTab(tabName) {
  console.log('Switching to tab:', tabName);
  
  // Hide all tabs
  document.querySelectorAll('.tab-content').forEach(tab => {
    tab.classList.remove('active');
  });
  
  // Remove active class from all buttons
  document.querySelectorAll('.tab-button').forEach(btn => {
    btn.classList.remove('active');
  });
  
  // Show selected tab
  const selectedTab = document.getElementById(`${tabName}-tab`);
  if (selectedTab) {
    selectedTab.classList.add('active');
  }
  
  // Mark button as active
  const buttons = document.querySelectorAll('.tab-button');
  buttons.forEach(btn => {
    if (btn.textContent.toLowerCase().includes(tabName)) {
      btn.classList.add('active');
    }
  });
  
  // Load tab-specific data
  switch(tabName) {
    case 'console':
      refreshTmuxLogs();
      break;
    case 'logs':
      refreshLogs();
      break;
    case 'monitor':
      checkMonitorStatus();
      break;
    case 'chat':
      loadChatMessages();
      break;
    case 'conversation':
      refreshConversationList();
      break;
    case 'status':
      updateFullStatus();
      break;
    case 'schedule':
      loadScheduleConfig();
      break;
  }
}

// Dark mode toggle
function toggleDarkMode() {
  document.body.classList.toggle('dark-mode');
  const isDarkMode = document.body.classList.contains('dark-mode');
  localStorage.setItem('darkMode', isDarkMode);
  
  const btn = document.getElementById('toggle-dark-mode');
  if (btn) {
    btn.textContent = isDarkMode ? '☀️' : '🌙';
  }
}

// Session management
async function loadSessions() {
  try {
    const sessions = await dashboardAPI.getTmuxSessions();
    const select = document.getElementById('session-select');
    if (!select) return;
    
    select.innerHTML = '';
    
    if (sessions && sessions.length > 0) {
      sessions.forEach(session => {
        const option = document.createElement('option');
        option.value = session;
        option.textContent = session;
        if (session === currentSession) {
          option.selected = true;
        }
        select.appendChild(option);
      });
    } else {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No sessions available';
      select.appendChild(option);
    }
    
    select.addEventListener('change', (e) => {
      currentSession = e.target.value;
      updateStatus();
      loadConfig();
    });
  } catch (error) {
    console.error('Failed to load sessions:', error);
  }
}

async function createNewSession() {
  const sessionName = prompt('Enter session name:');
  if (!sessionName) return;
  
  try {
    await dashboardAPI.createTmuxSession(sessionName);
    await loadSessions();
    currentSession = sessionName;
    alert(`Session '${sessionName}' created successfully`);
  } catch (error) {
    console.error('Failed to create session:', error);
    alert('Failed to create session: ' + error.message);
  }
}

async function killCurrentSession() {
  if (!currentSession) {
    alert('No session selected');
    return;
  }
  
  if (!confirm(`Are you sure you want to kill session '${currentSession}'?`)) {
    return;
  }
  
  try {
    await dashboardAPI.killTmuxSession(currentSession);
    await loadSessions();
    alert(`Session '${currentSession}' killed`);
  } catch (error) {
    console.error('Failed to kill session:', error);
    alert('Failed to kill session: ' + error.message);
  }
}

// Control functions
async function sendControl(action) {
  try {
    const result = await dashboardAPI.sendControl(action, currentSession);
    console.log(`Control action '${action}' sent:`, result);
    updateStatus();
  } catch (error) {
    console.error(`Failed to send control '${action}':`, error);
    alert(`Failed to ${action}: ${error.message}`);
  }
}

async function sendCustomMessage() {
  const textarea = document.getElementById('custom-message');
  if (!textarea) return;
  
  const message = textarea.value.trim();
  if (!message) {
    alert('Please enter a message');
    return;
  }
  
  try {
    await dashboardAPI.sendMessage(message, currentSession);
    textarea.value = '';
    alert('Message sent successfully');
  } catch (error) {
    console.error('Failed to send message:', error);
    alert('Failed to send message: ' + error.message);
  }
}

// Status updates
async function updateStatus() {
  try {
    const status = await dashboardAPI.getStatus(currentSession);
    
    const indicator = document.getElementById('status-indicator');
    const text = document.getElementById('status-text');
    
    if (indicator && text) {
      if (status.running) {
        indicator.style.color = '#4CAF50';
        text.textContent = status.paused ? 'Paused' : 'Running';
      } else {
        indicator.style.color = '#f44336';
        text.textContent = 'Stopped';
      }
    }
    
    // Update context display if on control tab
    const contextDisplay = document.getElementById('context-info');
    if (contextDisplay && contextDisplay.offsetParent !== null) {
      updateContext();
    }
  } catch (error) {
    console.error('Failed to update status:', error);
  }
}

async function updateContext() {
  try {
    const context = await dashboardAPI.getContext(currentSession);
    
    const usage = document.getElementById('context-usage');
    const threshold = document.getElementById('context-threshold');
    const status = document.getElementById('context-status');
    
    if (usage) usage.textContent = context.usage || 'N/A';
    if (threshold) threshold.textContent = context.threshold || 'N/A';
    if (status) status.textContent = context.needsCompact ? 'Needs Compact' : 'OK';
  } catch (error) {
    console.error('Failed to update context:', error);
  }
}

async function updateFullStatus() {
  try {
    // Update loop status
    const status = await dashboardAPI.getStatus(currentSession);
    
    document.getElementById('loop-state').textContent = status.state || 'Unknown';
    document.getElementById('loop-running').textContent = status.running ? 'Yes' : 'No';
    document.getElementById('loop-last-update').textContent = new Date().toLocaleTimeString();
    
    // Update session info
    const sessions = await dashboardAPI.getTmuxSessions();
    document.getElementById('current-session').textContent = currentSession || 'None';
    document.getElementById('active-sessions').textContent = sessions.length;
    document.getElementById('session-start').textContent = status.startTime || 'N/A';
    
    // Update performance (placeholder values)
    document.getElementById('memory-usage').textContent = '42 MB';
    document.getElementById('cpu-load').textContent = '12%';
    document.getElementById('uptime').textContent = '2h 15m';
    
    // Update auto-resume status
    const autoResumeInfo = document.getElementById('auto-resume-info');
    if (autoResumeInfo) {
      try {
        const autoStatus = await dashboardAPI.getAutoResumeStatus();
        autoResumeInfo.innerHTML = `
          <div class="status-item">
            <span class="label">Enabled:</span>
            <span>${autoStatus.enabled ? 'Yes' : 'No'}</span>
          </div>
          <div class="status-item">
            <span class="label">Last Check:</span>
            <span>${autoStatus.lastCheck || 'Never'}</span>
          </div>
          <div class="status-item">
            <span class="label">Next Check:</span>
            <span>${autoStatus.nextCheck || 'N/A'}</span>
          </div>
        `;
      } catch (error) {
        autoResumeInfo.innerHTML = '<div class="error">Failed to load auto-resume status</div>';
      }
    }
  } catch (error) {
    console.error('Failed to update full status:', error);
  }
}

// Configuration
async function loadConfig() {
  try {
    const config = await dashboardAPI.getConfig(currentSession);
    
    if (config) {
      document.getElementById('api-key').value = config.apiKey || '';
      document.getElementById('model').value = config.model || 'claude-3-opus-20240229';
      document.getElementById('compact-threshold').value = config.compactThreshold || 10;
      document.getElementById('check-interval').value = config.checkInterval || 30;
      document.getElementById('auto-resume').checked = config.autoResume || false;
      document.getElementById('working-dir').value = config.workingDir || '';
    }
  } catch (error) {
    console.error('Failed to load config:', error);
  }
}

async function saveConfig(e) {
  e.preventDefault();
  
  const config = {
    apiKey: document.getElementById('api-key').value,
    model: document.getElementById('model').value,
    compactThreshold: parseInt(document.getElementById('compact-threshold').value),
    checkInterval: parseInt(document.getElementById('check-interval').value),
    autoResume: document.getElementById('auto-resume').checked,
    workingDir: document.getElementById('working-dir').value
  };
  
  try {
    await dashboardAPI.saveConfig(config, currentSession);
    alert('Configuration saved successfully');
  } catch (error) {
    console.error('Failed to save config:', error);
    alert('Failed to save configuration: ' + error.message);
  }
}

// Console functions
async function refreshTmuxLogs() {
  try {
    const logs = await dashboardAPI.getTmuxLogs(false, currentSession);
    const console = document.getElementById('tmux-console');
    
    if (console) {
      console.innerHTML = dashboardUtils.convertAnsiToHtml(logs || 'No logs available');
      
      if (autoScrollConsole) {
        console.scrollTop = console.scrollHeight;
      }
    }
  } catch (error) {
    console.error('Failed to refresh tmux logs:', error);
  }
}

function clearTmuxLogs() {
  const console = document.getElementById('tmux-console');
  if (console) {
    console.innerHTML = '';
  }
}

async function sendToTmux() {
  const input = document.getElementById('tmux-command');
  if (!input) return;
  
  const command = input.value.trim();
  if (!command) return;
  
  try {
    await dashboardAPI.sendToTmux(command, currentSession);
    input.value = '';
    setTimeout(refreshTmuxLogs, 500);
  } catch (error) {
    console.error('Failed to send tmux command:', error);
    alert('Failed to send command: ' + error.message);
  }
}

function handleTmuxInput(event) {
  if (event.key === 'Enter') {
    sendToTmux();
  }
}

// Logs functions
async function refreshLogs() {
  try {
    const lines = document.getElementById('log-lines').value;
    const logs = await dashboardAPI.getLogs(lines, currentSession);
    const output = document.getElementById('logs-output');
    
    if (output) {
      output.innerHTML = dashboardUtils.convertAnsiToHtml(logs || 'No logs available');
      output.scrollTop = output.scrollHeight;
    }
  } catch (error) {
    console.error('Failed to refresh logs:', error);
  }
}

// Monitor functions
async function setMonitorType(type) {
  try {
    await dashboardAPI.setMonitorType(type);
    console.log(`Monitor type set to: ${type}`);
  } catch (error) {
    console.error('Failed to set monitor type:', error);
  }
}

async function startMonitor() {
  const typeInputs = document.querySelectorAll('input[name="monitor-type"]');
  let type = 'console';
  
  typeInputs.forEach(input => {
    if (input.checked) {
      type = input.value;
    }
  });
  
  try {
    await dashboardAPI.startLogMonitor(type, currentSession);
    alert(`Monitor started for ${currentSession} (${type})`);
    checkMonitorStatus();
  } catch (error) {
    console.error('Failed to start monitor:', error);
    alert('Failed to start monitor: ' + error.message);
  }
}

async function stopMonitor() {
  try {
    await dashboardAPI.stopLogMonitor(currentSession);
    alert('Monitor stopped');
    checkMonitorStatus();
  } catch (error) {
    console.error('Failed to stop monitor:', error);
    alert('Failed to stop monitor: ' + error.message);
  }
}

async function checkMonitorStatus() {
  try {
    const status = await dashboardAPI.getLogMonitorStatus(currentSession);
    const info = document.getElementById('monitor-info');
    
    if (info) {
      if (status.running) {
        info.innerHTML = `
          <div class="status-item">
            <span class="label">Status:</span>
            <span class="value success">Running</span>
          </div>
          <div class="status-item">
            <span class="label">Type:</span>
            <span class="value">${status.type || 'Unknown'}</span>
          </div>
          <div class="status-item">
            <span class="label">Session:</span>
            <span class="value">${status.session || 'Unknown'}</span>
          </div>
          <div class="status-item">
            <span class="label">PID:</span>
            <span class="value">${status.pid || 'Unknown'}</span>
          </div>
        `;
      } else {
        info.innerHTML = '<div class="status-item">Not running</div>';
      }
    }
  } catch (error) {
    console.error('Failed to check monitor status:', error);
  }
}

// Chat functions
async function loadChatMessages() {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  
  try {
    container.innerHTML = '<div class="loading">Loading conversation...</div>';
    await dashboardUtils.loadChatMessages();
  } catch (error) {
    console.error('Failed to load chat messages:', error);
    container.innerHTML = '<div class="error">Failed to load messages</div>';
  }
}

// Conversation functions
async function scanConversations() {
  try {
    const result = await dashboardAPI.scanConversations(false);
    alert(`Found ${result.count || 0} conversations`);
    refreshConversationList();
  } catch (error) {
    console.error('Failed to scan conversations:', error);
    alert('Failed to scan conversations: ' + error.message);
  }
}

async function fullScanConversations() {
  try {
    const result = await dashboardAPI.scanConversations(true);
    alert(`Full scan complete. Found ${result.count || 0} conversations`);
    refreshConversationList();
  } catch (error) {
    console.error('Failed to perform full scan:', error);
    alert('Failed to perform full scan: ' + error.message);
  }
}

async function refreshConversationList() {
  const tree = document.getElementById('conversation-tree');
  if (!tree) return;
  
  try {
    const conversations = await dashboardAPI.getConversationTree();
    
    if (conversations && conversations.length > 0) {
      tree.innerHTML = buildConversationTree(conversations);
    } else {
      tree.innerHTML = '<div class="empty">No conversations found</div>';
    }
  } catch (error) {
    console.error('Failed to refresh conversation list:', error);
    tree.innerHTML = '<div class="error">Failed to load conversations</div>';
  }
}

function buildConversationTree(conversations) {
  let html = '<ul class="tree-list">';
  
  conversations.forEach(conv => {
    html += `
      <li class="tree-item">
        <div class="tree-node" onclick="selectConversation('${conv.id}')">
          <span class="tree-icon">📁</span>
          <span class="tree-label">${conv.name || conv.id}</span>
          <span class="tree-meta">${conv.messageCount || 0} messages</span>
        </div>
      </li>
    `;
  });
  
  html += '</ul>';
  return html;
}

async function selectConversation(id) {
  selectedConversation = id;
  
  // Enable action buttons
  document.querySelectorAll('.conversation-actions-detail button').forEach(btn => {
    btn.disabled = false;
  });
  
  // Load conversation details
  try {
    const conv = await dashboardAPI.getConversation(id);
    const info = document.getElementById('conversation-info');
    
    if (info && conv) {
      info.innerHTML = `
        <div class="info-item">
          <span class="label">ID:</span>
          <span class="value">${conv.id}</span>
        </div>
        <div class="info-item">
          <span class="label">Name:</span>
          <span class="value">${conv.name || 'Unnamed'}</span>
        </div>
        <div class="info-item">
          <span class="label">Messages:</span>
          <span class="value">${conv.messageCount || 0}</span>
        </div>
        <div class="info-item">
          <span class="label">Created:</span>
          <span class="value">${conv.created || 'Unknown'}</span>
        </div>
        <div class="info-item">
          <span class="label">Project:</span>
          <span class="value">${conv.project || 'None'}</span>
        </div>
      `;
    }
  } catch (error) {
    console.error('Failed to load conversation details:', error);
  }
}

async function trackConversation() {
  if (!selectedConversation) return;
  
  try {
    await dashboardAPI.trackConversation(selectedConversation, currentSession);
    alert('Conversation tracked in current session');
  } catch (error) {
    console.error('Failed to track conversation:', error);
    alert('Failed to track conversation: ' + error.message);
  }
}

async function assignToProject() {
  if (!selectedConversation) return;
  
  const project = prompt('Enter project name:');
  if (!project) return;
  
  try {
    await dashboardAPI.assignConversation(selectedConversation, project);
    alert('Conversation assigned to project');
    selectConversation(selectedConversation);
  } catch (error) {
    console.error('Failed to assign conversation:', error);
    alert('Failed to assign conversation: ' + error.message);
  }
}

async function renameConversation() {
  if (!selectedConversation) return;
  
  const name = prompt('Enter new name:');
  if (!name) return;
  
  try {
    await dashboardAPI.renameConversation(selectedConversation, name);
    alert('Conversation renamed');
    refreshConversationList();
    selectConversation(selectedConversation);
  } catch (error) {
    console.error('Failed to rename conversation:', error);
    alert('Failed to rename conversation: ' + error.message);
  }
}

async function deleteConversation() {
  if (!selectedConversation) return;
  
  if (!confirm('Are you sure you want to delete this conversation?')) return;
  
  try {
    await dashboardAPI.deleteConversation(selectedConversation);
    alert('Conversation deleted');
    selectedConversation = null;
    refreshConversationList();
    document.getElementById('conversation-info').innerHTML = '<p>Select a conversation to view details</p>';
  } catch (error) {
    console.error('Failed to delete conversation:', error);
    alert('Failed to delete conversation: ' + error.message);
  }
}

// Schedule functions
function updateScheduleFields() {
  const type = document.getElementById('schedule-type').value;
  
  // Hide all field groups
  document.querySelectorAll('.schedule-fields').forEach(fields => {
    fields.style.display = 'none';
  });
  
  // Show selected field group
  const selectedFields = document.getElementById(`${type}-fields`);
  if (selectedFields) {
    selectedFields.style.display = 'block';
  }
}

async function loadScheduleConfig() {
  try {
    const config = await dashboardAPI.getScheduleConfig();
    
    if (config) {
      document.getElementById('schedule-enabled').checked = config.enabled || false;
      document.getElementById('schedule-type').value = config.type || 'interval';
      updateScheduleFields();
      
      // Load type-specific fields
      if (config.type === 'interval') {
        document.getElementById('interval-value').value = config.intervalValue || 30;
        document.getElementById('interval-unit').value = config.intervalUnit || 'minutes';
      } else if (config.type === 'daily') {
        document.getElementById('daily-time').value = config.dailyTime || '09:00';
      } else if (config.type === 'weekly') {
        document.getElementById('weekly-time').value = config.weeklyTime || '09:00';
        // Set weekday checkboxes
        if (config.weekdays) {
          document.querySelectorAll('input[name="weekdays"]').forEach(cb => {
            cb.checked = config.weekdays.includes(parseInt(cb.value));
          });
        }
      } else if (config.type === 'cron') {
        document.getElementById('cron-expression').value = config.cronExpression || '';
      }
      
      document.getElementById('schedule-command').value = config.command || '';
      document.getElementById('schedule-session').value = config.session || '';
    }
    
    // Update schedule info display
    const info = document.getElementById('schedule-info');
    if (info) {
      if (config && config.enabled) {
        info.innerHTML = `
          <div class="info-item">
            <span class="label">Status:</span>
            <span class="value success">Enabled</span>
          </div>
          <div class="info-item">
            <span class="label">Type:</span>
            <span class="value">${config.type}</span>
          </div>
          <div class="info-item">
            <span class="label">Next Run:</span>
            <span class="value">${config.nextRun || 'Calculating...'}</span>
          </div>
        `;
      } else {
        info.innerHTML = '<div class="info-item">Schedule disabled</div>';
      }
    }
  } catch (error) {
    console.error('Failed to load schedule config:', error);
  }
}

async function saveSchedule(e) {
  e.preventDefault();
  
  const config = {
    enabled: document.getElementById('schedule-enabled').checked,
    type: document.getElementById('schedule-type').value,
    command: document.getElementById('schedule-command').value,
    session: document.getElementById('schedule-session').value
  };
  
  // Add type-specific fields
  if (config.type === 'interval') {
    config.intervalValue = parseInt(document.getElementById('interval-value').value);
    config.intervalUnit = document.getElementById('interval-unit').value;
  } else if (config.type === 'daily') {
    config.dailyTime = document.getElementById('daily-time').value;
  } else if (config.type === 'weekly') {
    config.weeklyTime = document.getElementById('weekly-time').value;
    config.weekdays = [];
    document.querySelectorAll('input[name="weekdays"]:checked').forEach(cb => {
      config.weekdays.push(parseInt(cb.value));
    });
  } else if (config.type === 'cron') {
    config.cronExpression = document.getElementById('cron-expression').value;
  }
  
  try {
    await dashboardAPI.saveScheduleConfig(config);
    alert('Schedule configuration saved');
    loadScheduleConfig();
  } catch (error) {
    console.error('Failed to save schedule:', error);
    alert('Failed to save schedule: ' + error.message);
  }
}

// Export functions for global access
window.switchTab = switchTab;
window.toggleDarkMode = toggleDarkMode;
window.createNewSession = createNewSession;
window.killCurrentSession = killCurrentSession;
window.sendControl = sendControl;
window.sendCustomMessage = sendCustomMessage;
window.refreshTmuxLogs = refreshTmuxLogs;
window.clearTmuxLogs = clearTmuxLogs;
window.sendToTmux = sendToTmux;
window.handleTmuxInput = handleTmuxInput;
window.refreshLogs = refreshLogs;
window.setMonitorType = setMonitorType;
window.startMonitor = startMonitor;
window.stopMonitor = stopMonitor;
window.checkMonitorStatus = checkMonitorStatus;
window.loadChatMessages = loadChatMessages;
window.scanConversations = scanConversations;
window.fullScanConversations = fullScanConversations;
window.refreshConversationList = refreshConversationList;
window.selectConversation = selectConversation;
window.trackConversation = trackConversation;
window.assignToProject = assignToProject;
window.renameConversation = renameConversation;
window.deleteConversation = deleteConversation;
window.updateScheduleFields = updateScheduleFields;