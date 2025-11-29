#!/usr/bin/env node

/**
 * Todo Manager Utility for Claude
 * Provides tools to manage, reorganize, and backup todo lists
 */

const fs = require('fs').promises;
const path = require('path');
const http = require('http');

const API_BASE = 'http://localhost:3335';

class TodoManager {
  constructor() {
    this.backupDir = path.join(__dirname, 'backups');
  }

  /**
   * Fetch all todos from the API
   */
  async fetchTodos() {
    return new Promise((resolve, reject) => {
      http.get(`${API_BASE}/api/todos`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });
  }

  /**
   * Fetch available sessions/projects from the API
   */
  async fetchSessions() {
    return new Promise((resolve, reject) => {
      http.get(`${API_BASE}/api/tmux-sessions`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            resolve(result.sessionsWithNames || result.sessions || []);
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });
  }

  /**
   * Save todos via API
   */
  async saveTodos(todos) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({ todos });
      const options = {
        hostname: 'localhost',
        port: 3335,
        path: '/api/todos/bulk-update',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  /**
   * Backup current todos
   */
  async backup(label = '') {
    const todos = await this.fetchTodos();
    await fs.mkdir(this.backupDir, { recursive: true });
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `todos-backup-${timestamp}${label ? '-' + label : ''}.json`;
    const filepath = path.join(this.backupDir, filename);
    
    await fs.writeFile(filepath, JSON.stringify(todos, null, 2));
    console.log(`✅ Backed up ${todos.length} todos to: ${filename}`);
    return filename;
  }

  /**
   * List available backups
   */
  async listBackups() {
    try {
      const files = await fs.readdir(this.backupDir);
      const backups = files.filter(f => f.startsWith('todos-backup-'));
      console.log('\n📁 Available backups:');
      backups.forEach((file, i) => {
        console.log(`  ${i + 1}. ${file}`);
      });
      return backups;
    } catch (e) {
      console.log('No backups found');
      return [];
    }
  }

  /**
   * Restore from backup
   */
  async restore(filename) {
    const filepath = path.join(this.backupDir, filename);
    const data = await fs.readFile(filepath, 'utf8');
    const todos = JSON.parse(data);
    
    // Backup current state before restoring
    await this.backup('before-restore');
    
    await this.saveTodos(todos);
    console.log(`✅ Restored ${todos.length} todos from: ${filename}`);
  }

  /**
   * Analyze and suggest reorganization
   */
  async analyzeTodos(showProjects = true) {
    const todos = await this.fetchTodos();
    
    const analysis = {
      total: todos.length,
      byStatus: {},
      byProject: {},
      byPriority: {},
      orphaned: [],
      availableProjects: [],
      suggestions: []
    };

    // Get available sessions/projects
    if (showProjects) {
      try {
        const sessions = await this.fetchSessions();
        analysis.availableProjects = sessions.map(s => {
          if (typeof s === 'string') {
            return { id: s, name: s };
          } else {
            return {
              id: s.id,
              name: s.hasCustomName ? s.name : s.id
            };
          }
        });
      } catch (e) {
        console.log('Could not fetch available sessions');
      }
    }

    todos.forEach(todo => {
      // Count by status
      analysis.byStatus[todo.status] = (analysis.byStatus[todo.status] || 0) + 1;
      
      // Count by project
      const project = todo.project || 'unassigned';
      analysis.byProject[project] = (analysis.byProject[project] || 0) + 1;
      
      // Count by priority
      analysis.byPriority[todo.priority] = (analysis.byPriority[todo.priority] || 0) + 1;
      
      // Find orphaned sub-tasks
      if (todo.parentId && !todos.find(t => t.id === todo.parentId)) {
        analysis.orphaned.push(todo);
      }
    });

    // Generate suggestions
    if (analysis.orphaned.length > 0) {
      analysis.suggestions.push(`Found ${analysis.orphaned.length} orphaned sub-tasks that should be fixed`);
    }

    const highPriorityPending = todos.filter(t => t.priority === 'high' && t.status === 'pending');
    if (highPriorityPending.length > 5) {
      analysis.suggestions.push(`You have ${highPriorityPending.length} high-priority pending items - consider focusing on these`);
    }

    return analysis;
  }

  /**
   * Smart reorganization - groups related todos and creates logical hierarchy
   */
  async reorganize(options = {}) {
    const todos = await this.fetchTodos();
    
    // Backup before reorganizing
    await this.backup('before-reorganize');
    
    // Only reorganize pending todos, keep completed ones as-is
    const pendingTodos = todos.filter(t => t.status === 'pending');
    const completedTodos = todos.filter(t => t.status !== 'pending');
    
    // Group by keywords and patterns (only pending todos)
    const groups = this.identifyGroups(pendingTodos);
    
    // Create hierarchy based on groups (don't add new parent tasks)
    if (options.createHierarchy) {
      this.createHierarchyWithoutNewTasks(pendingTodos, groups);
    }
    
    // Reorganize across projects if requested
    if (options.reorganizeProjects) {
      await this.reorganizeAcrossProjects(pendingTodos);
    }
    
    // Sort by priority and status
    if (options.sortByPriority) {
      pendingTodos.sort((a, b) => {
        const priorityOrder = { high: 0, medium: 1, normal: 2, low: 3 };
        
        // First by priority
        const priorityDiff = (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2);
        if (priorityDiff !== 0) return priorityDiff;
        
        // Then by creation date (older first)
        return new Date(a.created_at) - new Date(b.created_at);
      });
    }
    
    // Combine pending and completed todos
    const reorganized = [...pendingTodos, ...completedTodos];
    
    // Update order properties
    reorganized.forEach((todo, index) => {
      todo.order = index;
    });
    
    await this.saveTodos(reorganized);
    console.log(`✅ Reorganized ${pendingTodos.length} pending todos (kept ${completedTodos.length} completed)`);
    
    return {
      original: todos,
      reorganized: reorganized,
      groups: groups
    };
  }

  /**
   * Reorganize todos across different projects based on their content
   */
  async reorganizeAcrossProjects(todos) {
    const sessions = await this.fetchSessions();
    
    // Map session names to IDs for matching
    const sessionMap = {};
    sessions.forEach(s => {
      if (typeof s === 'string') {
        sessionMap[s.toLowerCase()] = s;
      } else {
        sessionMap[s.id.toLowerCase()] = s.id;
        if (s.hasCustomName && s.name) {
          sessionMap[s.name.toLowerCase()] = s.id;
        }
      }
    });

    // Special project assignments based on content
    todos.forEach(todo => {
      const text = todo.text.toLowerCase();
      
      // Skip if already assigned to a project
      if (todo.project && todo.project !== 'unassigned') {
        return;
      }
      
      // Dashboard-related todos -> Working on Claude loop (claude-loop9)
      if (text.includes('dashboard') || text.includes('todo') || text.includes('checkbox') || 
          text.includes('countdown') || text.includes('tmux')) {
        todo.project = 'claude-loop9'; // Working on Claude loop
        console.log(`📁 Assigning dashboard todo to claude-loop9: "${todo.text.substring(0, 50)}..."`);
      }
      // Skills and InfiniQuest related -> claude-loop8 or claude-loop3
      else if (text.includes('skill') || text.includes('infini')) {
        if (text.includes('template')) {
          todo.project = 'claude-loop8'; // Populate skills template db
        } else {
          todo.project = 'claude-loop3'; // Infiniquest
        }
        console.log(`📁 Assigning skills todo to ${todo.project}: "${todo.text.substring(0, 50)}..."`);
      }
      // CBT/therapy related -> might go to claude-loop3 (Infiniquest)
      else if (text.includes('cognitive') || text.includes('therapy') || text.includes('cbt')) {
        todo.project = 'claude-loop3'; // Infiniquest
        console.log(`📁 Assigning therapy todo to claude-loop3: "${todo.text.substring(0, 50)}..."`);
      }
      // Detect mentions of specific sessions/projects
      else {
        Object.entries(sessionMap).forEach(([key, sessionId]) => {
          if (text.includes(key)) {
            todo.project = sessionId;
            console.log(`📁 Moving "${todo.text.substring(0, 50)}..." to ${sessionId}`);
          }
        });
      }
    });
  }

  /**
   * Identify related groups of todos
   */
  identifyGroups(todos) {
    const groups = {};
    
    // Common keywords that indicate grouping
    const patterns = [
      { pattern: /dashboard/i, group: 'Dashboard' },
      { pattern: /todo|task/i, group: 'Todo System' },
      { pattern: /fix|bug|error/i, group: 'Bug Fixes' },
      { pattern: /feature|add|implement/i, group: 'Features' },
      { pattern: /test|testing/i, group: 'Testing' },
      { pattern: /doc|document/i, group: 'Documentation' },
      { pattern: /ui|interface|button|display/i, group: 'UI/UX' },
      { pattern: /api|backend|server/i, group: 'Backend' },
      { pattern: /refactor|clean|optimize/i, group: 'Refactoring' }
    ];
    
    todos.forEach(todo => {
      let assigned = false;
      for (const { pattern, group } of patterns) {
        if (pattern.test(todo.text)) {
          if (!groups[group]) groups[group] = [];
          groups[group].push(todo);
          assigned = true;
          break;
        }
      }
      
      if (!assigned) {
        if (!groups['Other']) groups['Other'] = [];
        groups['Other'].push(todo);
      }
    });
    
    return groups;
  }

  /**
   * Create hierarchy from groups WITHOUT adding new tasks
   */
  createHierarchyWithoutNewTasks(todos, groups) {
    // For each group, find the best candidate to be the parent
    Object.entries(groups).forEach(([groupName, groupTodos]) => {
      if (groupTodos.length > 1) {
        // Find the most suitable task to be the parent
        // Prefer tasks that:
        // 1. Are more general/overview-like
        // 2. Were created earlier
        // 3. Have higher priority
        
        let parent = null;
        
        // Look for a task that mentions the group name and seems like an overview
        parent = groupTodos.find(t => 
          t.text.toLowerCase().includes(groupName.toLowerCase()) && 
          (t.text.includes('implement') || t.text.includes('add') || t.text.includes('create') || t.text.includes('fix'))
        );
        
        // If no good parent found, use the first task in the group
        if (!parent) {
          parent = groupTodos[0];
        }
        
        // Make other group items children of the parent
        groupTodos.forEach(todo => {
          if (todo.id !== parent.id && !todo.parentId) {
            todo.parentId = parent.id;
          }
        });
      }
    });
  }
  
  /**
   * Create hierarchy from groups (OLD VERSION - adds new tasks)
   */
  createHierarchy(todos, groups) {
    // Create parent tasks for each group
    Object.entries(groups).forEach(([groupName, groupTodos]) => {
      if (groupTodos.length > 1) {
        // Find or create a parent task for this group
        let parent = todos.find(t => 
          t.text.toLowerCase().includes(groupName.toLowerCase()) && 
          !t.parentId
        );
        
        if (!parent) {
          // Create a new parent task
          parent = {
            id: `group-${Date.now()}-${Math.random()}`,
            text: `${groupName} Tasks`,
            status: 'pending',
            priority: 'medium',
            project: groupTodos[0].project || 'general',
            created: new Date().toISOString()
          };
          todos.push(parent);
        }
        
        // Make group items children of the parent
        groupTodos.forEach(todo => {
          if (todo.id !== parent.id && !todo.parentId) {
            todo.parentId = parent.id;
          }
        });
      }
    });
  }

  /**
   * Interactive CLI interface
   */
  async interactive() {
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const question = (prompt) => new Promise(resolve => rl.question(prompt, resolve));

    console.log('\n🗂️  Todo Manager for Claude\n');
    
    // Show available projects upfront
    console.log('📁 Available Projects/Sessions:');
    try {
      const sessions = await this.fetchSessions();
      sessions.forEach(s => {
        if (typeof s === 'string') {
          console.log(`  • ${s}`);
        } else {
          console.log(`  • ${s.hasCustomName ? s.name : s.id}${s.hasCustomName ? ` (${s.id})` : ''}`);
        }
      });
      console.log('');
    } catch (e) {
      console.log('  (Could not fetch sessions)\n');
    }
    
    console.log('Commands:');
    console.log('  1. Analyze todos');
    console.log('  2. Reorganize todos (within projects)');
    console.log('  3. Reorganize todos (across projects)');
    console.log('  4. Backup todos');
    console.log('  5. List backups');
    console.log('  6. Restore from backup');
    console.log('  7. Exit');

    while (true) {
      const choice = await question('\nEnter choice (1-7): ');
      
      try {
        switch (choice) {
          case '1':
            const analysis = await this.analyzeTodos();
            console.log('\n📊 Analysis:');
            console.log(`Total todos: ${analysis.total}`);
            console.log('\nBy Status:', analysis.byStatus);
            console.log('By Project:', analysis.byProject);
            console.log('By Priority:', analysis.byPriority);
            
            if (analysis.availableProjects.length > 0) {
              console.log('\n📁 Available Projects for Reorganization:');
              analysis.availableProjects.forEach(p => {
                const count = analysis.byProject[p.id] || 0;
                console.log(`  • ${p.name}${p.id !== p.name ? ` (${p.id})` : ''}: ${count} todos`);
              });
            }
            
            if (analysis.suggestions.length > 0) {
              console.log('\n💡 Suggestions:');
              analysis.suggestions.forEach(s => console.log(`  - ${s}`));
            }
            break;
            
          case '2':
            console.log('\n📋 Reorganize within existing projects');
            const createHierarchy = (await question('Create hierarchy? (y/n): ')).toLowerCase() === 'y';
            const sortByPriority = (await question('Sort by priority? (y/n): ')).toLowerCase() === 'y';
            await this.reorganize({ createHierarchy, sortByPriority, reorganizeProjects: false });
            break;
            
          case '3':
            console.log('\n🔄 Reorganize across projects');
            console.log('This will analyze todo content and move items to appropriate projects.');
            const confirm = await question('Continue? (y/n): ');
            if (confirm.toLowerCase() === 'y') {
              const createHierarchy2 = (await question('Also create hierarchy? (y/n): ')).toLowerCase() === 'y';
              const sortByPriority2 = (await question('Also sort by priority? (y/n): ')).toLowerCase() === 'y';
              await this.reorganize({ 
                createHierarchy: createHierarchy2, 
                sortByPriority: sortByPriority2,
                reorganizeProjects: true 
              });
            }
            break;
            
          case '4':
            const label = await question('Backup label (optional): ');
            await this.backup(label);
            break;
            
          case '5':
            await this.listBackups();
            break;
            
          case '6':
            const backups = await this.listBackups();
            if (backups.length > 0) {
              const index = await question('Enter backup number to restore: ');
              const backup = backups[parseInt(index) - 1];
              if (backup) {
                await this.restore(backup);
              } else {
                console.log('Invalid selection');
              }
            }
            break;
            
          case '7':
            rl.close();
            return;
            
          default:
            console.log('Invalid choice');
        }
      } catch (error) {
        console.error('Error:', error.message);
      }
    }
  }
}

// CLI interface
if (require.main === module) {
  const manager = new TodoManager();
  const args = process.argv.slice(2);
  
  // Default non-interactive mode - just show info and exit
  if (args.length === 0) {
    (async () => {
      console.log('\n🗂️  Todo Manager for Claude\n');
      
      // Show available projects
      console.log('📁 Available Projects/Sessions:');
      try {
        const sessions = await manager.fetchSessions();
        sessions.forEach(s => {
          if (typeof s === 'string') {
            console.log(`  • ${s}`);
          } else {
            console.log(`  • ${s.hasCustomName ? s.name : s.id}${s.hasCustomName ? ` (${s.id})` : ''}`);
          }
        });
      } catch (e) {
        console.log('  (Could not fetch sessions)');
      }
      
      // Show analysis
      const analysis = await manager.analyzeTodos();
      console.log(`\n📊 Current Status:`);
      console.log(`  Total todos: ${analysis.total}`);
      console.log('  By Status:', analysis.byStatus);
      console.log('  By Project:', analysis.byProject);
      
      if (analysis.suggestions.length > 0) {
        console.log('\n💡 Suggestions:');
        analysis.suggestions.forEach(s => console.log(`  - ${s}`));
      }
      
      console.log('\n📚 Available Commands:');
      console.log('  node todo-utils/todo-manager.js analyze          - Show this analysis');
      console.log('  node todo-utils/todo-manager.js reorganize       - Reorganize within projects');
      console.log('  node todo-utils/todo-manager.js reorganize --cross-project - Move todos between projects');
      console.log('  node todo-utils/todo-manager.js backup [label]   - Create backup');
      console.log('  node todo-utils/todo-manager.js list-backups     - List available backups');
      console.log('  node todo-utils/todo-manager.js restore <file>   - Restore from backup');
      console.log('  node todo-utils/todo-manager.js interactive      - Start interactive menu');
      console.log('  node todo-utils/reorganize-todos.js              - Quick reorganization');
      
      process.exit(0);
    })();
  } else {
    const [command, ...params] = args;
    
    switch (command) {
      case 'interactive':
        // Only start interactive mode when explicitly requested
        manager.interactive();
        break;
      case 'backup':
        manager.backup(params[0]);
        break;
      case 'restore':
        manager.restore(params[0]);
        break;
      case 'analyze':
        manager.analyzeTodos().then(analysis => {
          console.log(JSON.stringify(analysis, null, 2));
        });
        break;
      case 'reorganize':
        manager.reorganize({
          createHierarchy: params.includes('--hierarchy'),
          sortByPriority: params.includes('--sort'),
          reorganizeProjects: params.includes('--cross-project')
        });
        break;
      case 'list-backups':
        manager.listBackups();
        break;
      default:
        console.log('Usage: todo-manager.js [command] [options]');
        console.log('Commands:');
        console.log('  (no command)       - Show current status and available commands');
        console.log('  analyze            - Analyze todo structure (JSON output)');
        console.log('  backup [label]     - Backup current todos');
        console.log('  restore <file>     - Restore from backup');
        console.log('  reorganize         - Reorganize todos');
        console.log('    --hierarchy      - Create logical hierarchy');
        console.log('    --sort           - Sort by priority');
        console.log('    --cross-project  - Move todos between projects based on content');
        console.log('  list-backups       - List available backups');
        console.log('  interactive        - Start interactive menu');
    }
  }
}

module.exports = TodoManager;