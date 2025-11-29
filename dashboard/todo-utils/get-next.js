#!/usr/bin/env node

/**
 * Get Next Todo - Simple utility for Claude to get the next task to work on
 * Usage: node todo-utils/get-next.js [project]
 */

const http = require('http');

// Get project from command line or environment
const project = process.argv[2] || process.env.CLAUDE_SESSION || null;

function fetchNextTodo() {
  // Build URL with optional project filter and compact format
  let url = 'http://localhost:3335/api/todos/pending?format=compact';
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
          console.log('No pending todos found' + (project ? ` for project ${project}` : ''));
          process.exit(0);
        }
        
        // Sort by priority (high > normal > low) and age
        const priorityOrder = { high: 3, normal: 2, low: 1 };
        todos.sort((a, b) => {
          // First by priority
          const priorityDiff = (priorityOrder[b.priority] || 2) - (priorityOrder[a.priority] || 2);
          if (priorityDiff !== 0) return priorityDiff;
          
          // Then by creation date (older first)
          return new Date(a.created_at) - new Date(b.created_at);
        });
        
        // Return the top task
        const next = todos[0];
        console.log(`ID: ${next.id}`);
        console.log(`Priority: ${next.priority || 'normal'}`);
        console.log(`Project: ${next.project || 'unassigned'}`);
        console.log(`Task: ${next.text}`);
        
        if (next.parentId) {
          console.log(`Parent: ${next.parentId}`);
        }
        
      } catch (e) {
        console.error('Failed to parse response:', e.message);
        process.exit(1);
      }
    });
  }).on('error', (e) => {
    console.error('Failed to fetch todos:', e.message);
    process.exit(1);
  });
}

fetchNextTodo();