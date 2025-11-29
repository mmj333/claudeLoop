#!/usr/bin/env node

/**
 * Todo Export Utility
 * Export todos in various formats (Markdown, CSV, JSON, etc.)
 */

const fs = require('fs').promises;
const path = require('path');
const TodoManager = require('./todo-manager');

class TodoExporter {
  constructor() {
    this.manager = new TodoManager();
  }

  /**
   * Export as Markdown
   */
  async toMarkdown(outputFile = 'todos.md') {
    const todos = await this.manager.fetchTodos();
    
    let markdown = '# Todo List\n\n';
    markdown += `_Generated: ${new Date().toLocaleString()}_\n\n`;
    
    // Group by project
    const byProject = {};
    todos.forEach(todo => {
      const project = todo.project || 'General';
      if (!byProject[project]) byProject[project] = [];
      byProject[project].push(todo);
    });
    
    // Render each project
    Object.entries(byProject).forEach(([project, projectTodos]) => {
      markdown += `## ${project}\n\n`;
      
      // Render hierarchy
      const renderTodo = (todo, depth = 0) => {
        const indent = '  '.repeat(depth);
        const checkbox = todo.status === 'user_approved' ? '[x]' : 
                        todo.status === 'claude_done' ? '[~]' : '[ ]';
        const priority = todo.priority === 'high' ? '🔴' : 
                        todo.priority === 'low' ? '🟢' : '🟡';
        
        let line = `${indent}- ${checkbox} ${priority} ${todo.text}`;
        if (todo.notes && todo.notes.length > 0) {
          line += '\n' + todo.notes.map(n => `${indent}  > ${n.text}`).join('\n');
        }
        return line;
      };
      
      // Build hierarchy
      const topLevel = projectTodos.filter(t => !t.parentId);
      topLevel.forEach(todo => {
        markdown += renderTodo(todo) + '\n';
        
        // Render children
        const children = projectTodos.filter(t => t.parentId === todo.id);
        children.forEach(child => {
          markdown += renderTodo(child, 1) + '\n';
        });
      });
      
      markdown += '\n';
    });
    
    await fs.writeFile(outputFile, markdown);
    console.log(`✅ Exported ${todos.length} todos to ${outputFile}`);
    return markdown;
  }

  /**
   * Export as CSV
   */
  async toCSV(outputFile = 'todos.csv') {
    const todos = await this.manager.fetchTodos();
    
    const headers = ['ID', 'Text', 'Status', 'Priority', 'Category', 'Project', 'Parent ID', 'Created', 'Updated'];
    const rows = [headers.join(',')];
    
    todos.forEach(todo => {
      const row = [
        todo.id,
        `"${(todo.text || '').replace(/"/g, '""')}"`,
        todo.status,
        todo.priority,
        todo.category || '',
        todo.project || '',
        todo.parentId || '',
        todo.created || '',
        todo.updated || ''
      ];
      rows.push(row.join(','));
    });
    
    const csv = rows.join('\n');
    await fs.writeFile(outputFile, csv);
    console.log(`✅ Exported ${todos.length} todos to ${outputFile}`);
    return csv;
  }

  /**
   * Export as simple text list
   */
  async toText(outputFile = 'todos.txt') {
    const todos = await this.manager.fetchTodos();
    
    let text = 'TODO LIST\n';
    text += '=========\n\n';
    
    const pending = todos.filter(t => t.status === 'pending');
    const claudeDone = todos.filter(t => t.status === 'claude_done');
    const approved = todos.filter(t => t.status === 'user_approved');
    
    if (pending.length > 0) {
      text += 'PENDING:\n';
      pending.forEach(todo => {
        text += `  - ${todo.text}\n`;
      });
      text += '\n';
    }
    
    if (claudeDone.length > 0) {
      text += 'AWAITING APPROVAL:\n';
      claudeDone.forEach(todo => {
        text += `  - ${todo.text}\n`;
      });
      text += '\n';
    }
    
    if (approved.length > 0) {
      text += 'COMPLETED:\n';
      approved.forEach(todo => {
        text += `  ✓ ${todo.text}\n`;
      });
    }
    
    await fs.writeFile(outputFile, text);
    console.log(`✅ Exported ${todos.length} todos to ${outputFile}`);
    return text;
  }

  /**
   * Export for Claude to read
   */
  async forClaude(outputFile = 'todos-for-claude.md') {
    const todos = await this.manager.fetchTodos();
    const analysis = await this.manager.analyzeTodos();
    
    let content = '# Current Todo List Status\n\n';
    content += '## Summary\n';
    content += `- Total items: ${analysis.total}\n`;
    content += `- Pending: ${analysis.byStatus.pending || 0}\n`;
    content += `- Awaiting approval: ${analysis.byStatus.claude_done || 0}\n`;
    content += `- Completed: ${analysis.byStatus.user_approved || 0}\n\n`;
    
    // High priority items
    const highPriority = todos.filter(t => t.priority === 'high' && t.status === 'pending');
    if (highPriority.length > 0) {
      content += '## 🔴 High Priority Items\n';
      highPriority.forEach(todo => {
        content += `- ${todo.text}\n`;
      });
      content += '\n';
    }
    
    // Items awaiting approval
    const awaitingApproval = todos.filter(t => t.status === 'claude_done');
    if (awaitingApproval.length > 0) {
      content += '## 🟡 Awaiting Your Approval\n';
      awaitingApproval.forEach(todo => {
        content += `- ${todo.text}\n`;
      });
      content += '\n';
    }
    
    // Suggestions
    if (analysis.suggestions.length > 0) {
      content += '## 💡 Suggestions\n';
      analysis.suggestions.forEach(s => {
        content += `- ${s}\n`;
      });
    }
    
    await fs.writeFile(outputFile, content);
    console.log(`✅ Created Claude-friendly summary in ${outputFile}`);
    return content;
  }
}

// CLI interface
if (require.main === module) {
  const exporter = new TodoExporter();
  const format = process.argv[2] || 'markdown';
  const outputFile = process.argv[3];
  
  switch (format) {
    case 'markdown':
    case 'md':
      exporter.toMarkdown(outputFile);
      break;
    case 'csv':
      exporter.toCSV(outputFile);
      break;
    case 'text':
    case 'txt':
      exporter.toText(outputFile);
      break;
    case 'claude':
      exporter.forClaude(outputFile);
      break;
    default:
      console.log('Usage: export-todos.js [format] [output-file]');
      console.log('Formats: markdown, csv, text, claude');
      console.log('Example: node export-todos.js markdown todos.md');
  }
}

module.exports = TodoExporter;