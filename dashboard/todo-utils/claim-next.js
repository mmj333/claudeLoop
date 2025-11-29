#!/usr/bin/env node

/**
 * Claim Next Todo - Get next task from dashboard and add to Claude's native todos
 * Usage: node todo-utils/claim-next.js [conversationId] [project]
 * 
 * This tool:
 * 1. Gets the highest priority pending todo from dashboard
 * 2. Marks it as in_progress in dashboard
 * 3. Adds it to Claude's native todo list for this conversation
 */

const fs = require('fs').promises;
const path = require('path');
const http = require('http');
const os = require('os');

// Get conversation ID from environment or generate one
const conversationId = process.argv[2] || process.env.CLAUDE_CONVERSATION_ID || 
                       `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

// Get project/session from environment or command line
const project = process.argv[3] || process.env.CLAUDE_SESSION || null;

const CLAUDE_TODOS_DIR = path.join(os.homedir(), '.claude', 'todos');
const nativeTodoFile = path.join(CLAUDE_TODOS_DIR, `${conversationId}-agent-${conversationId}.json`);

async function fetchNextPendingTodo() {
  return new Promise((resolve, reject) => {
    // Get pending todos with compact format for efficiency
    // If project is specified, filter by it
    let url = `http://localhost:3335/api/todos/pending?format=compact`;
    if (project) {
      url += `&project=${project}`;
    }
    
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const todos = JSON.parse(data);
          
          if (todos.length === 0) {
            resolve(null);
            return;
          }
          
          // Sort by priority and age
          const priorityOrder = { high: 3, normal: 2, low: 1 };
          todos.sort((a, b) => {
            const priorityDiff = (priorityOrder[b.priority] || 2) - (priorityOrder[a.priority] || 2);
            if (priorityDiff !== 0) return priorityDiff;
            return 0; // Could add date sorting here if needed
          });
          
          resolve(todos[0]);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function updateTodoStatus(todoId, status) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      id: todoId,
      status: status,
      claude_session: conversationId
    });
    
    const options = {
      hostname: 'localhost',
      port: 3335,
      path: '/api/todos/update',
      method: 'PUT',
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

async function loadNativeTodos() {
  try {
    const content = await fs.readFile(nativeTodoFile, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    // File doesn't exist or is empty, return empty array
    return [];
  }
}

async function saveNativeTodos(todos) {
  await fs.mkdir(CLAUDE_TODOS_DIR, { recursive: true });
  await fs.writeFile(nativeTodoFile, JSON.stringify(todos, null, 2));
}

async function claimNextTodo() {
  try {
    // Get next pending todo from dashboard
    const nextTodo = await fetchNextPendingTodo();
    
    if (!nextTodo) {
      console.log(`No pending todos available to claim${project ? ` for project ${project}` : ''}.`);
      process.exit(0);
    }
    
    console.log(`\n📋 Claiming todo: ${nextTodo.text.substring(0, 50)}...`);
    
    // Mark as in_progress in dashboard
    await updateTodoStatus(nextTodo.id, 'in_progress');
    console.log('✓ Marked as in_progress in dashboard');
    
    // Load current native todos
    const nativeTodos = await loadNativeTodos();
    
    // Check if already exists (avoid duplicates)
    const exists = nativeTodos.some(t => t.dashboardId === nextTodo.id);
    if (exists) {
      console.log('✓ Already in native todos');
    } else {
      // Add to native todos with reference to dashboard
      const nativeTodo = {
        id: String(nativeTodos.length + 1),
        content: nextTodo.text,
        status: 'pending',
        dashboardId: nextTodo.id,
        priority: nextTodo.priority,
        project: nextTodo.project,
        claimedAt: new Date().toISOString()
      };
      
      nativeTodos.push(nativeTodo);
      await saveNativeTodos(nativeTodos);
      console.log('✓ Added to native todos');
    }
    
    // Output for Claude to use
    console.log('\n' + '='.repeat(50));
    console.log('NEXT TASK:');
    console.log('='.repeat(50));
    console.log(`Priority: ${nextTodo.priority}`);
    console.log(`Project: ${nextTodo.project}`);
    console.log(`Task: ${nextTodo.text}`);
    console.log('='.repeat(50));
    console.log('\nThis task has been claimed and added to your todo list.');
    console.log(`Native todo file: ${nativeTodoFile}`);
    
  } catch (error) {
    console.error('Failed to claim todo:', error.message);
    process.exit(1);
  }
}

// Run the claim process
claimNextTodo();