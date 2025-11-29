#!/usr/bin/env node

/**
 * Import Skills - Batch import skill names as todos for Claude to work through
 * Usage: node import-skills.js <input-file> [project]
 * 
 * Input file can be:
 * - Text file with one skill per line
 * - JSON array of skill names
 * - CSV with skill names in first column
 */

const fs = require('fs').promises;
const http = require('http');
const path = require('path');

async function apiRequest(method, endpoint, data = null) {
  return new Promise((resolve, reject) => {
    const postData = data ? JSON.stringify(data) : '';
    const options = {
      hostname: 'localhost',
      port: 3335,
      path: endpoint,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
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
    if (postData) req.write(postData);
    req.end();
  });
}

async function generateTodoId() {
  // Generate a unique ID similar to the dashboard's format
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = 'skill';
  for (let i = 0; i < 15; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

async function importSkills(inputFile, project = 'skill-seeding') {
  try {
    // Read input file
    const content = await fs.readFile(inputFile, 'utf8');
    const ext = path.extname(inputFile).toLowerCase();
    
    let skills = [];
    
    // Parse based on file type
    if (ext === '.json') {
      const data = JSON.parse(content);
      skills = Array.isArray(data) ? data : data.skills || [];
    } else if (ext === '.csv') {
      // Simple CSV parsing (assumes first column or comma-separated)
      skills = content.split('\n')
        .map(line => line.split(',')[0].trim())
        .filter(s => s && !s.startsWith('#')); // Skip empty and comments
    } else {
      // Plain text - one skill per line
      skills = content.split('\n')
        .map(line => line.trim())
        .filter(s => s && !s.startsWith('#')); // Skip empty and comments
    }
    
    console.log(`Found ${skills.length} skills to import`);
    
    // Get existing todos to append to
    const existingTodos = await apiRequest('GET', '/api/todos');
    
    // Create todos for each skill
    const newTodos = [];
    const batchSize = 10; // Import in batches to avoid overwhelming
    
    for (let i = 0; i < skills.length; i++) {
      const skill = skills[i];
      
      // Check if already exists
      const exists = existingTodos.some(t => 
        t.text === `Generate skill template: ${skill}` && 
        t.project === project
      );
      
      if (exists) {
        console.log(`Skipping duplicate: ${skill}`);
        continue;
      }
      
      const todo = {
        id: await generateTodoId(),
        text: `Generate skill template: ${skill}`,
        status: 'pending',
        priority: 'normal',
        project: project,
        created_at: new Date().toISOString(),
        notes: [`Skill: ${skill}`, `Category: [to be determined]`],
        metadata: {
          type: 'skill_template',
          skill_name: skill,
          template_status: 'pending'
        }
      };
      
      newTodos.push(todo);
      
      // Import in batches using new bulk-add endpoint
      if (newTodos.length >= batchSize) {
        console.log(`Importing batch of ${newTodos.length} skills...`);
        const result = await apiRequest('POST', '/api/todos/bulk-add', {
          project: project,
          todos: newTodos
        });
        console.log(`  Added ${result.added || newTodos.length} todos`);
        newTodos.length = 0; // Clear batch
      }
    }
    
    // Import remaining
    if (newTodos.length > 0) {
      console.log(`Importing final batch of ${newTodos.length} skills...`);
      const result = await apiRequest('POST', '/api/todos/bulk-add', {
        project: project,
        todos: newTodos
      });
      console.log(`  Added ${result.added || newTodos.length} todos`);
    }
    
    // Show statistics
    const stats = await apiRequest('GET', `/api/todos?project=${project}`);
    const projectTodos = JSON.parse(stats).filter(t => t.project === project);
    
    console.log('\n✅ Import complete!');
    console.log(`Total skill todos in project '${project}': ${projectTodos.length}`);
    console.log(`  Pending: ${projectTodos.filter(t => t.status === 'pending').length}`);
    console.log(`  In Progress: ${projectTodos.filter(t => t.status === 'in_progress').length}`);
    console.log(`  Completed: ${projectTodos.filter(t => t.status === 'claude_done').length}`);
    console.log('\nClaude can now work through these with:');
    console.log(`  node todo-utils/todo-client.js claim ${project}`);
    
  } catch (error) {
    console.error('Import failed:', error.message);
    process.exit(1);
  }
}

// Main
const [,, inputFile, project] = process.argv;

if (!inputFile) {
  console.log(`Skill Import Tool - Batch import skills as todos

Usage: node import-skills.js <input-file> [project]

Arguments:
  input-file   Path to file containing skill names
               Supported formats: .txt, .json, .csv
  project      Project name (default: skill-seeding)

File formats:
  .txt   One skill per line
  .json  Array of strings or {skills: [...]}
  .csv   Skill names in first column

Example files:

skills.txt:
  JavaScript Programming
  Python Basics
  # This is a comment
  Data Structures

skills.json:
  ["JavaScript", "Python", "Data Structures"]

skills.csv:
  JavaScript Programming, beginner, coding
  Python Basics, beginner, coding

Example usage:
  node import-skills.js skills.txt
  node import-skills.js skills.json infiniquest-skills`);
  process.exit(0);
}

importSkills(inputFile, project);