#!/usr/bin/env node

/**
 * Todo Client - Efficient CLI for Claude to interact with dashboard todos
 * Usage: node todo-client.js [command] [options]
 * 
 * Commands:
 *   list [status] [project]  - List todos (pending, in_progress, etc.)
 *   get <id>                 - Get specific todo details
 *   update <id> <field> <value> - Update a todo field
 *   claim [project]          - Claim next todo from single project
 *   claim-multi <projects...> - Claim highest priority todo across multiple projects
 *   complete <id>            - Mark todo as claude_done
 *   search <query>           - Search todos by text
 *   stats [project]          - Show todo statistics
 */

const http = require('http');
const fs = require('fs').promises;
const path = require('path');

// Parse command line arguments
const [,, command, ...args] = process.argv;

// API helper function
function apiRequest(method, endpoint, data = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 3335,
      path: endpoint,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(responseData));
        } catch (e) {
          resolve(responseData);
        }
      });
    });

    req.on('error', reject);

    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

// Command implementations
const commands = {
  // List todos with optional filters
  list: async (status = 'pending', project = null) => {
    let url = '/api/todos';
    const params = new URLSearchParams();
    
    if (status !== 'all') {
      if (status === 'pending') {
        url = '/api/todos/pending';
      } else {
        params.append('status', status);
      }
    }
    
    if (project) {
      params.append('project', project);
    }
    params.append('format', 'compact');
    
    if (params.toString()) {
      url += '?' + params.toString();
    }
    
    const todos = await apiRequest('GET', url);
    
    if (!todos || todos.length === 0) {
      console.log('No todos found');
      return;
    }
    
    // Format output
    const filtered = status === 'all' ? todos : 
      (status === 'pending' ? todos : todos.filter(t => t.status === status));
    
    filtered.forEach(todo => {
      const priority = todo.priority === 'high' ? '[HIGH]' : 
                      todo.priority === 'low' ? '[LOW]' : '';
      const project = todo.project || 'unassigned';
      console.log(`${todo.id} ${priority} [${project}] ${todo.text || todo.content}`);
    });
    
    console.log(`\n${filtered.length} todos found`);
  },

  // Get specific todo details
  get: async (todoId) => {
    if (!todoId) {
      console.error('Usage: todo-client get <id>');
      process.exit(1);
    }
    
    const todos = await apiRequest('GET', '/api/todos');
    const todo = todos.find(t => t.id === todoId);
    
    if (!todo) {
      console.error('Todo not found:', todoId);
      process.exit(1);
    }
    
    // Display all fields
    console.log('ID:', todo.id);
    console.log('Text:', todo.text);
    console.log('Status:', todo.status);
    console.log('Priority:', todo.priority || 'normal');
    console.log('Project:', todo.project || 'unassigned');
    console.log('Created:', new Date(todo.created_at).toLocaleString());
    if (todo.completed_at) {
      console.log('Completed:', new Date(todo.completed_at).toLocaleString());
    }
    if (todo.notes && todo.notes.length > 0) {
      console.log('Notes:');
      todo.notes.forEach(note => console.log('  -', note));
    }
    if (todo.parentId) {
      console.log('Parent:', todo.parentId);
    }
  },

  // Update a todo field
  update: async (todoId, field, ...valueParts) => {
    if (!todoId || !field || valueParts.length === 0) {
      console.error('Usage: todo-client update <id> <field> <value>');
      console.error('Fields: status, priority, project, text, notes');
      process.exit(1);
    }
    
    const value = valueParts.join(' ');
    
    const updateData = {
      id: todoId,
      [field]: field === 'notes' ? [value] : value
    };
    
    await apiRequest('PUT', '/api/todos/update', updateData);
    console.log(`Updated ${field} for todo ${todoId}`);
  },

  // Claim next todo (simplified version)
  claim: async (project = null) => {
    project = project || process.env.CLAUDE_SESSION;
    
    // Get next pending todo
    let url = '/api/todos/pending?format=compact';
    if (project) {
      url += `&project=${project}`;
    }
    
    const todos = await apiRequest('GET', url);
    
    if (!todos || todos.length === 0) {
      console.log('No pending todos to claim');
      process.exit(0);
    }
    
    // Sort by priority
    const priorityOrder = { high: 3, normal: 2, low: 1 };
    todos.sort((a, b) => {
      const priorityDiff = (priorityOrder[b.priority] || 2) - (priorityOrder[a.priority] || 2);
      if (priorityDiff !== 0) return priorityDiff;
      return new Date(a.created_at) - new Date(b.created_at);
    });
    
    const next = todos[0];
    
    // Update status to in_progress
    await apiRequest('PUT', '/api/todos/update', {
      id: next.id,
      status: 'in_progress',
      claude_session: project
    });
    
    console.log('Claimed todo:', next.id);
    console.log('Text:', next.text);
    console.log('Priority:', next.priority || 'normal');
    console.log('Project:', next.project || 'unassigned');
  },
  
  // Claim next todo from multiple projects with priority-based selection
  'claim-multi': async (...projects) => {
    if (projects.length === 0) {
      console.error('Usage: todo-client claim-multi <project1> <project2> ...');
      console.error('Example: todo-client claim-multi skills-physical skill-seeding skills-academic');
      process.exit(1);
    }
    
    // Fetch todos from all specified projects
    const allTodos = [];
    console.log(`Scanning ${projects.length} projects for todos...`);
    
    for (const project of projects) {
      const url = `/api/todos/pending?format=compact&project=${project}`;
      const todos = await apiRequest('GET', url);
      if (todos && todos.length > 0) {
        allTodos.push(...todos);
        console.log(`  ${project}: ${todos.length} pending todos`);
      } else {
        console.log(`  ${project}: no pending todos`);
      }
    }
    
    if (allTodos.length === 0) {
      console.log('\nNo pending todos found in any of the specified projects');
      process.exit(0);
    }
    
    // Sort by priority (high > normal > low) and then by order field
    const priorityOrder = { high: 3, normal: 2, low: 1 };
    allTodos.sort((a, b) => {
      // First sort by priority
      const priorityA = priorityOrder[a.priority] || 2;
      const priorityB = priorityOrder[b.priority] || 2;
      if (priorityA !== priorityB) {
        return priorityB - priorityA;
      }
      
      // Then sort by order (position in list)
      const orderA = a.order !== undefined ? a.order : 999999;
      const orderB = b.order !== undefined ? b.order : 999999;
      return orderA - orderB;
    });
    
    // Count todos by priority for summary
    const priorityCounts = { high: 0, normal: 0, low: 0 };
    allTodos.forEach(todo => {
      priorityCounts[todo.priority || 'normal']++;
    });
    
    console.log(`\nFound ${allTodos.length} total pending todos:`);
    console.log(`  High priority: ${priorityCounts.high}`);
    console.log(`  Normal priority: ${priorityCounts.normal}`);
    console.log(`  Low priority: ${priorityCounts.low}`);
    
    // Claim the highest priority todo
    const next = allTodos[0];
    
    console.log('\n' + '='.repeat(60));
    console.log('CLAIMING HIGHEST PRIORITY TODO');
    console.log('='.repeat(60));
    
    // Update status to in_progress
    await apiRequest('PUT', '/api/todos/update', {
      id: next.id,
      status: 'in_progress',
      claude_session: process.env.CLAUDE_SESSION || 'claude'
    });
    
    console.log('ID:', next.id);
    console.log('Priority:', next.priority || 'normal');
    console.log('Project:', next.project || 'unassigned');
    console.log('Position:', next.order !== undefined ? `#${next.order + 1} in project list` : 'not ordered');
    console.log('\nTask:');
    console.log(next.text);
    console.log('='.repeat(60));
    console.log('\nThis task has been claimed and marked as in_progress');
  },

  // Mark todo as complete
  complete: async (todoId) => {
    if (!todoId) {
      console.error('Usage: todo-client complete <id>');
      process.exit(1);
    }
    
    await apiRequest('PUT', '/api/todos/update', {
      id: todoId,
      status: 'claude_done',
      completed_at: new Date().toISOString()
    });
    
    console.log(`Marked ${todoId} as complete`);
  },

  // Search todos
  search: async (...queryParts) => {
    const query = queryParts.join(' ');
    if (!query) {
      console.error('Usage: todo-client search <query>');
      process.exit(1);
    }
    
    const url = `/api/todos/search?q=${encodeURIComponent(query)}&format=compact`;
    const todos = await apiRequest('GET', url);
    
    if (!todos || todos.length === 0) {
      console.log('No todos found matching:', query);
      return;
    }
    
    todos.forEach(todo => {
      const status = todo.status === 'pending' ? '⏳' : 
                    todo.status === 'in_progress' ? '🔄' :
                    todo.status === 'claude_done' ? '✅' : '✓';
      console.log(`${status} ${todo.id} [${todo.project || 'unassigned'}] ${todo.text}`);
    });
    
    console.log(`\n${todos.length} todos found`);
  },

  // Show statistics
  stats: async (project = null) => {
    let todos = await apiRequest('GET', '/api/todos');
    
    if (project) {
      todos = todos.filter(t => t.project === project);
    }
    
    const stats = {
      total: todos.length,
      pending: todos.filter(t => t.status === 'pending').length,
      in_progress: todos.filter(t => t.status === 'in_progress').length,
      claude_done: todos.filter(t => t.status === 'claude_done').length,
      user_approved: todos.filter(t => t.status === 'user_approved').length
    };
    
    const priorities = {
      high: todos.filter(t => t.priority === 'high').length,
      normal: todos.filter(t => t.priority === 'normal' || !t.priority).length,
      low: todos.filter(t => t.priority === 'low').length
    };
    
    console.log('Todo Statistics' + (project ? ` for ${project}` : ''));
    console.log('================');
    console.log('Total:', stats.total);
    console.log('\nBy Status:');
    console.log('  Pending:', stats.pending);
    console.log('  In Progress:', stats.in_progress);
    console.log('  Claude Done:', stats.claude_done);
    console.log('  User Approved:', stats.user_approved);
    console.log('\nBy Priority:');
    console.log('  High:', priorities.high);
    console.log('  Normal:', priorities.normal);
    console.log('  Low:', priorities.low);
    
    // Show projects if not filtered
    if (!project) {
      const projects = {};
      todos.forEach(t => {
        const p = t.project || 'unassigned';
        projects[p] = (projects[p] || 0) + 1;
      });
      
      console.log('\nBy Project:');
      Object.entries(projects)
        .sort((a, b) => b[1] - a[1])
        .forEach(([proj, count]) => {
          console.log(`  ${proj}: ${count}`);
        });
    }
  },
  
  // List all projects
  projects: async () => {
    const todos = await apiRequest('GET', '/api/todos');
    
    // Get unique projects from todos
    const projectStats = {};
    todos.forEach(t => {
      const p = t.project || 'unassigned';
      if (!projectStats[p]) {
        projectStats[p] = {
          total: 0,
          pending: 0,
          in_progress: 0,
          completed: 0
        };
      }
      projectStats[p].total++;
      if (t.status === 'pending') projectStats[p].pending++;
      else if (t.status === 'in_progress' || t.status === 'claude_working') projectStats[p].in_progress++;
      else if (t.status === 'claude_done' || t.status === 'user_approved') projectStats[p].completed++;
    });
    
    console.log('Available Projects');
    console.log('==================');
    
    // Sort by total todos descending
    const sorted = Object.entries(projectStats)
      .sort((a, b) => b[1].total - a[1].total);
    
    if (sorted.length === 0) {
      console.log('No projects found. Add todos with project names to create projects.');
      return;
    }
    
    sorted.forEach(([project, stats]) => {
      const pendingStr = stats.pending > 0 ? `${stats.pending} pending` : '';
      const progressStr = stats.in_progress > 0 ? `${stats.in_progress} in progress` : '';
      const completedStr = stats.completed > 0 ? `${stats.completed} completed` : '';
      
      const parts = [pendingStr, progressStr, completedStr].filter(s => s);
      
      console.log(`\n${project}: ${stats.total} todos`);
      if (parts.length > 0) {
        console.log(`  └─ ${parts.join(', ')}`);
      }
    });
    
    console.log('\n' + '─'.repeat(40));
    console.log(`Total: ${sorted.length} projects, ${todos.length} todos`);
  },
  
  // Add a new todo
  add: async (...args) => {
    // Parse arguments - could be: text [project] [priority]
    let text = '';
    let project = null;
    let priority = 'normal';
    
    // Join all args and look for flags
    const fullText = args.join(' ');
    
    // Check for --project or -p flag
    const projectMatch = fullText.match(/(?:--project|-p)\s+(\S+)/);
    if (projectMatch) {
      project = projectMatch[1];
      text = fullText.replace(projectMatch[0], '').trim();
    } else {
      // Check if last arg looks like a project (claude-loop*, skill-seeding, etc)
      const lastArg = args[args.length - 1];
      if (lastArg && (lastArg.startsWith('claude-loop') || lastArg === 'skill-seeding' || !lastArg.includes(' '))) {
        project = lastArg;
        text = args.slice(0, -1).join(' ');
      } else {
        text = fullText;
      }
    }
    
    // Check for priority flag
    const priorityMatch = text.match(/(?:--priority|-pr)\s+(high|normal|low)/);
    if (priorityMatch) {
      priority = priorityMatch[1];
      text = text.replace(priorityMatch[0], '').trim();
    }
    
    if (!text) {
      console.error('Error: Todo text is required');
      console.log('Usage: add "todo text" [project] [--priority high|normal|low]');
      return;
    }
    
    // Generate ID similar to dashboard format
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = 'meq';
    for (let i = 0; i < 15; i++) {
      id += chars[Math.floor(Math.random() * chars.length)];
    }
    
    const todo = {
      id,
      text,
      status: 'pending',
      priority,
      project,
      created_at: new Date().toISOString()
    };
    
    const result = await apiRequest('POST', '/api/todos', todo);
    
    console.log(`✅ Added todo: ${result.id || id}`);
    console.log(`   Text: ${text}`);
    if (project) console.log(`   Project: ${project}`);
    console.log(`   Priority: ${priority}`);
  },
  
  // Add a child todo to an existing parent
  'add-child': async (parentId, ...textArgs) => {
    if (!parentId || textArgs.length === 0) {
      console.error('Usage: add-child <parent-id> <text> [project]');
      return;
    }
    
    // Get parent todo first to verify it exists
    try {
      const parent = await apiRequest('GET', `/api/todos/${parentId}`);
      if (!parent || parent.error) {
        console.error(`❌ Parent todo not found: ${parentId}`);
        return;
      }
      
      // Parse text and project from remaining args
      let text = '';
      let project = parent.project; // Default to parent's project
      let priority = parent.priority || 'normal'; // Default to parent's priority
      
      // Check if last arg looks like a project
      const lastArg = textArgs[textArgs.length - 1];
      if (lastArg && (lastArg.startsWith('claude-loop') || lastArg === 'skill-seeding' || 
          lastArg.startsWith('skills-') || !lastArg.includes(' '))) {
        project = lastArg;
        text = textArgs.slice(0, -1).join(' ');
      } else {
        text = textArgs.join(' ');
      }
      
      // Generate ID
      const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let id = 'meq';
      for (let i = 0; i < 15; i++) {
        id += chars[Math.floor(Math.random() * chars.length)];
      }
      
      const todo = {
        id,
        text,
        status: 'pending',
        priority,
        project,
        parent_id: parentId, // Set parent relationship
        created_at: new Date().toISOString()
      };
      
      const result = await apiRequest('POST', '/api/todos', todo);
      
      console.log(`✅ Added child todo: ${result.id || id}`);
      console.log(`   Parent: ${parent.text.substring(0, 50)}... (${parentId})`);
      console.log(`   Child: ${text}`);
      if (project) console.log(`   Project: ${project}`);
      console.log(`   Priority: ${priority}`);
    } catch (error) {
      console.error('❌ Error adding child todo:', error.message);
    }
  },
  
  // List todos with hierarchy
  'list-tree': async (status = 'pending', project = null) => {
    const endpoint = project ? 
      `/api/todos?status=${status}&project=${project}` : 
      `/api/todos?status=${status}`;
    
    const todos = await apiRequest('GET', endpoint);
    
    if (!todos || todos.length === 0) {
      console.log('No todos found');
      return;
    }
    
    // Build parent-child map
    const parentMap = {};
    const rootTodos = [];
    
    todos.forEach(todo => {
      if (todo.parent_id) {
        if (!parentMap[todo.parent_id]) {
          parentMap[todo.parent_id] = [];
        }
        parentMap[todo.parent_id].push(todo);
      } else {
        rootTodos.push(todo);
      }
    });
    
    // Display function with indentation
    function displayTodo(todo, indent = '') {
      const priorityIcon = todo.priority === 'high' ? '🔴' : 
                          todo.priority === 'low' ? '🔵' : '⚪';
      const statusIcon = todo.status === 'in_progress' ? '🔄' :
                        todo.status === 'claude_done' ? '✅' :
                        todo.status === 'user_approved' ? '🎉' : '📝';
      
      console.log(`${indent}${statusIcon} ${priorityIcon} [${todo.id}] ${todo.text}`);
      if (todo.project) {
        console.log(`${indent}   📁 ${todo.project}`);
      }
      
      // Display children
      if (parentMap[todo.id]) {
        parentMap[todo.id].forEach(child => {
          displayTodo(child, indent + '  └─ ');
        });
      }
    }
    
    console.log(`\n${rootTodos.length} root todos (${Object.keys(parentMap).length} have children):\n`);
    rootTodos.forEach(todo => displayTodo(todo));
  }
};

// Show help if no command
if (!command || command === 'help' || command === '--help') {
  console.log(`Todo Client - Efficient CLI for dashboard todos

Commands:
  list [status] [project]     List todos (default: pending)
                              Status: pending, in_progress, claude_done, user_approved, all
  list-tree [status] [project] List todos with parent-child hierarchy
  get <id>                    Get specific todo details
  add <text> [project]        Add a new todo
  add-child <parent-id> <text> [project] Add a child todo to existing parent
  update <id> <field> <value> Update a todo field
                              Fields: status, priority, project, text, notes
  claim [project]             Claim next pending todo from single project
  claim-multi <projects...>   Claim highest priority todo across multiple projects
  complete <id>               Mark todo as claude_done
  search <query>              Search todos by text
  stats [project]             Show todo statistics
  projects                    List all available projects

Examples:
  node todo-client.js list                     # List all pending todos
  node todo-client.js list pending claude-loop9  # List pending for specific project
  node todo-client.js claim-multi skills-physical skill-seeding skills-academic
  node todo-client.js get abc123                # Get details for todo abc123
  node todo-client.js add "Fix bug" claude-loop9  # Add new todo to project
  node todo-client.js add "High priority task" -p claude-loop9 --priority high
  node todo-client.js update abc123 priority high  # Set priority to high
  node todo-client.js claim claude-loop9        # Claim next todo for project
  node todo-client.js complete abc123           # Mark as complete
  node todo-client.js search "dashboard bug"    # Search for todos
  node todo-client.js stats                     # Show statistics
  node todo-client.js projects                  # List all projects

Environment:
  CLAUDE_SESSION - Default project for claim and add commands`);
  process.exit(0);
}

// Execute command
async function main() {
  try {
    if (!commands[command]) {
      console.error(`Unknown command: ${command}`);
      console.error('Run "node todo-client.js help" for usage');
      process.exit(1);
    }
    
    await commands[command](...args);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();