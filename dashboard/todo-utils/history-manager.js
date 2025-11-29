#!/usr/bin/env node

/**
 * History Manager for Todo System
 * Implements change tracking and undo/redo functionality
 */

const fs = require('fs').promises;
const path = require('path');

class HistoryManager {
  constructor() {
    this.historyDir = path.join(__dirname, 'history');
    this.changesFile = path.join(this.historyDir, 'changes.jsonl');
    this.indexFile = path.join(this.historyDir, 'index.json');
    this.snapshotsDir = path.join(this.historyDir, 'snapshots');
    
    // In-memory cache for performance
    this.todoHistories = {}; // { todoId: [changes] }
    this.globalHistory = [];
    this.currentPositions = {}; // { todoId: position }
  }

  /**
   * Initialize history system
   */
  async init() {
    // Create directories if they don't exist
    await fs.mkdir(this.historyDir, { recursive: true });
    await fs.mkdir(this.snapshotsDir, { recursive: true });
    
    // Load existing history
    await this.loadHistory();
  }

  /**
   * Load history from disk
   */
  async loadHistory() {
    try {
      // Load changes
      const changesData = await fs.readFile(this.changesFile, 'utf8').catch(() => '');
      const changes = changesData.split('\n').filter(line => line.trim());
      
      // Parse and organize changes
      changes.forEach(line => {
        try {
          const change = JSON.parse(line);
          
          if (change.todoId) {
            if (!this.todoHistories[change.todoId]) {
              this.todoHistories[change.todoId] = [];
            }
            this.todoHistories[change.todoId].push(change);
          }
          
          // Add to global history if it's a bulk operation
          if (change.action === 'BULK_UPDATE' || change.action === 'REORGANIZE') {
            this.globalHistory.push(change);
          }
        } catch (e) {
          console.error('Error parsing change:', e);
        }
      });
      
      // Load index (current positions)
      try {
        const indexData = await fs.readFile(this.indexFile, 'utf8');
        const index = JSON.parse(indexData);
        this.currentPositions = index.positions || {};
      } catch (e) {
        // No index file yet, start fresh
        this.currentPositions = {};
      }
    } catch (error) {
      console.error('Error loading history:', error);
    }
  }

  /**
   * Log a change
   */
  async logChange(change) {
    // Add metadata
    const fullChange = {
      id: `change_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      ...change
    };
    
    // Append to file
    await fs.appendFile(this.changesFile, JSON.stringify(fullChange) + '\n');
    
    // Update in-memory cache
    if (fullChange.todoId) {
      if (!this.todoHistories[fullChange.todoId]) {
        this.todoHistories[fullChange.todoId] = [];
      }
      this.todoHistories[fullChange.todoId].push(fullChange);
      
      // Reset position for this todo (we're at the latest state)
      this.currentPositions[fullChange.todoId] = this.todoHistories[fullChange.todoId].length;
    }
    
    // Add to global history if applicable
    if (fullChange.action === 'BULK_UPDATE' || fullChange.action === 'REORGANIZE') {
      this.globalHistory.push(fullChange);
    }
    
    // Save index
    await this.saveIndex();
    
    return fullChange;
  }

  /**
   * Log multiple changes as a single operation
   */
  async logBulkChanges(changes, operationName = 'BULK_UPDATE') {
    const bulkChange = {
      id: `bulk_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      action: operationName,
      changes: changes,
      affectedTodos: changes.map(c => c.todoId).filter(Boolean)
    };
    
    // Log the bulk operation
    await fs.appendFile(this.changesFile, JSON.stringify(bulkChange) + '\n');
    
    // Log individual changes
    for (const change of changes) {
      await this.logChange(change);
    }
    
    this.globalHistory.push(bulkChange);
    return bulkChange;
  }

  /**
   * Undo last change for a specific todo
   */
  async undoTodo(todoId) {
    const history = this.todoHistories[todoId];
    if (!history || history.length === 0) {
      return { success: false, message: 'No history for this todo' };
    }
    
    const currentPos = this.currentPositions[todoId] || history.length;
    if (currentPos <= 0) {
      return { success: false, message: 'Nothing to undo' };
    }
    
    // Get the change to undo
    const changeToUndo = history[currentPos - 1];
    
    // Move position back
    this.currentPositions[todoId] = currentPos - 1;
    await this.saveIndex();
    
    return {
      success: true,
      change: changeToUndo,
      revert: this.getRevertOperation(changeToUndo)
    };
  }

  /**
   * Redo for a specific todo
   */
  async redoTodo(todoId) {
    const history = this.todoHistories[todoId];
    if (!history || history.length === 0) {
      return { success: false, message: 'No history for this todo' };
    }
    
    const currentPos = this.currentPositions[todoId] || history.length;
    if (currentPos >= history.length) {
      return { success: false, message: 'Nothing to redo' };
    }
    
    // Get the change to redo
    const changeToRedo = history[currentPos];
    
    // Move position forward
    this.currentPositions[todoId] = currentPos + 1;
    await this.saveIndex();
    
    return {
      success: true,
      change: changeToRedo,
      apply: this.getApplyOperation(changeToRedo)
    };
  }

  /**
   * Get revert operation for a change
   */
  getRevertOperation(change) {
    switch (change.action) {
      case 'UPDATE':
        return {
          action: 'UPDATE',
          todoId: change.todoId,
          field: change.field,
          value: change.oldValue
        };
      
      case 'ADD':
        return {
          action: 'DELETE',
          todoId: change.todoId
        };
      
      case 'DELETE':
        return {
          action: 'ADD',
          todoId: change.todoId,
          data: change.oldValue
        };
      
      case 'MOVE':
        return {
          action: 'MOVE',
          todoId: change.todoId,
          project: change.oldProject,
          parentId: change.oldParentId
        };
      
      default:
        return null;
    }
  }

  /**
   * Get apply operation for a change (for redo)
   */
  getApplyOperation(change) {
    switch (change.action) {
      case 'UPDATE':
        return {
          action: 'UPDATE',
          todoId: change.todoId,
          field: change.field,
          value: change.newValue
        };
      
      case 'ADD':
        return {
          action: 'ADD',
          todoId: change.todoId,
          data: change.newValue
        };
      
      case 'DELETE':
        return {
          action: 'DELETE',
          todoId: change.todoId
        };
      
      case 'MOVE':
        return {
          action: 'MOVE',
          todoId: change.todoId,
          project: change.newProject,
          parentId: change.newParentId
        };
      
      default:
        return change;
    }
  }

  /**
   * Get history for a specific todo
   */
  async getTodoHistory(todoId) {
    const history = this.todoHistories[todoId] || [];
    const currentPos = this.currentPositions[todoId] || history.length;
    
    return {
      history: history,
      currentPosition: currentPos,
      canUndo: currentPos > 0,
      canRedo: currentPos < history.length
    };
  }

  /**
   * Create a checkpoint (snapshot)
   */
  async createCheckpoint(name = null) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `checkpoint-${timestamp}${name ? '-' + name : ''}.json`;
    const filepath = path.join(this.snapshotsDir, filename);
    
    // Get current state from the API
    const http = require('http');
    const todos = await new Promise((resolve, reject) => {
      http.get('http://localhost:3335/api/todos', (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(JSON.parse(data)));
      }).on('error', reject);
    });
    
    const checkpoint = {
      timestamp: new Date().toISOString(),
      name: name,
      todoCount: todos.length,
      todos: todos,
      positions: this.currentPositions
    };
    
    await fs.writeFile(filepath, JSON.stringify(checkpoint, null, 2));
    
    return {
      filename: filename,
      timestamp: checkpoint.timestamp,
      name: name,
      todoCount: checkpoint.todoCount
    };
  }

  /**
   * List available checkpoints
   */
  async listCheckpoints() {
    const files = await fs.readdir(this.snapshotsDir);
    const checkpoints = [];
    
    for (const file of files) {
      if (file.startsWith('checkpoint-')) {
        const filepath = path.join(this.snapshotsDir, file);
        const data = await fs.readFile(filepath, 'utf8');
        const checkpoint = JSON.parse(data);
        
        checkpoints.push({
          filename: file,
          timestamp: checkpoint.timestamp,
          name: checkpoint.name,
          todoCount: checkpoint.todoCount
        });
      }
    }
    
    return checkpoints.sort((a, b) => 
      new Date(b.timestamp) - new Date(a.timestamp)
    );
  }

  /**
   * Restore from checkpoint
   */
  async restoreCheckpoint(filename) {
    const filepath = path.join(this.snapshotsDir, filename);
    const data = await fs.readFile(filepath, 'utf8');
    const checkpoint = JSON.parse(data);
    
    // Restore positions
    this.currentPositions = checkpoint.positions || {};
    await this.saveIndex();
    
    return checkpoint.todos;
  }

  /**
   * Save current positions to index file
   */
  async saveIndex() {
    const index = {
      updated: new Date().toISOString(),
      positions: this.currentPositions,
      globalPosition: this.globalHistory.length
    };
    
    await fs.writeFile(this.indexFile, JSON.stringify(index, null, 2));
  }

  /**
   * Clean up old history (older than days)
   */
  async cleanup(daysToKeep = 30) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    
    // Read all changes
    const changesData = await fs.readFile(this.changesFile, 'utf8').catch(() => '');
    const changes = changesData.split('\n').filter(line => line.trim());
    
    // Filter recent changes
    const recentChanges = changes.filter(line => {
      try {
        const change = JSON.parse(line);
        return new Date(change.timestamp) > cutoffDate;
      } catch {
        return false;
      }
    });
    
    // Rewrite the file with only recent changes
    await fs.writeFile(this.changesFile, recentChanges.join('\n') + '\n');
    
    // Reload history
    await this.loadHistory();
    
    return {
      originalCount: changes.length,
      keptCount: recentChanges.length,
      removedCount: changes.length - recentChanges.length
    };
  }

  /**
   * Get description of what will be undone
   */
  getUndoDescription(change) {
    switch (change.action) {
      case 'UPDATE':
        return `Revert ${change.field} from "${change.newValue}" to "${change.oldValue}"`;
      case 'ADD':
        return 'Remove this todo';
      case 'DELETE':
        return 'Restore deleted todo';
      case 'MOVE':
        return `Move back to ${change.oldProject || 'unassigned'}`;
      default:
        return 'Undo last change';
    }
  }
}

// Export for use in other modules
module.exports = HistoryManager;

// CLI interface for testing
if (require.main === module) {
  const manager = new HistoryManager();
  
  (async () => {
    await manager.init();
    
    const args = process.argv.slice(2);
    const [command, ...params] = args;
    
    switch (command) {
      case 'list':
        const checkpoints = await manager.listCheckpoints();
        console.log('Available checkpoints:');
        checkpoints.forEach(cp => {
          console.log(`  ${cp.filename} - ${cp.name || 'unnamed'} (${cp.todoCount} todos)`);
        });
        break;
      
      case 'checkpoint':
        const name = params[0];
        const checkpoint = await manager.createCheckpoint(name);
        console.log(`Created checkpoint: ${checkpoint.filename}`);
        break;
      
      case 'cleanup':
        const days = parseInt(params[0]) || 30;
        const result = await manager.cleanup(days);
        console.log(`Cleaned up history older than ${days} days`);
        console.log(`Removed ${result.removedCount} entries, kept ${result.keptCount}`);
        break;
      
      default:
        console.log('Usage:');
        console.log('  history-manager.js list                 - List checkpoints');
        console.log('  history-manager.js checkpoint [name]    - Create checkpoint');
        console.log('  history-manager.js cleanup [days]       - Clean old history');
    }
  })();
}