#!/usr/bin/env node

/*
 * Claude Conversation Monitor
 * Monitors Claude's active conversation by watching file changes
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

class ClaudeConversationMonitor {
    constructor(sessionName) {
        this.sessionName = sessionName;
        this.projectPath = process.cwd().replace(/\//g, '-');
        this.projectDir = path.join(os.homedir(), '.claude', 'projects', this.projectPath);
        this.lastActiveConversation = null;
        this.watchers = new Map();
    }

    // Monitor the project directory for new/modified conversation files
    startMonitoring(callback) {
        console.log(`Monitoring Claude conversations for session: ${this.sessionName}`);
        
        // Watch the project directory for changes
        fs.watch(this.projectDir, { persistent: false }, (eventType, filename) => {
            if (filename && filename.endsWith('.jsonl')) {
                const conversationId = filename.replace('.jsonl', '');
                this.checkConversationActivity(conversationId, callback);
            }
        });

        // Also poll for the most recently modified file every 5 seconds
        this.pollInterval = setInterval(() => {
            this.findActiveConversation(callback);
        }, 5000);
    }

    // Check if a conversation file was recently modified
    async checkConversationActivity(conversationId, callback) {
        const filePath = path.join(this.projectDir, `${conversationId}.jsonl`);
        
        try {
            const stats = await fs.promises.stat(filePath);
            const now = Date.now();
            const lastModified = stats.mtime.getTime();
            
            // If modified within last 10 seconds, consider it active
            if (now - lastModified < 10000) {
                if (this.lastActiveConversation !== conversationId) {
                    this.lastActiveConversation = conversationId;
                    console.log(`Active conversation changed to: ${conversationId}`);
                    
                    if (callback) {
                        callback({
                            sessionName: this.sessionName,
                            conversationId: conversationId,
                            timestamp: new Date().toISOString()
                        });
                    }
                }
            }
        } catch (err) {
            // File might have been deleted
        }
    }

    // Find the most recently modified conversation
    async findActiveConversation(callback) {
        try {
            const files = await fs.promises.readdir(this.projectDir);
            const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
            
            let mostRecent = null;
            let mostRecentTime = 0;
            
            for (const file of jsonlFiles) {
                const filePath = path.join(this.projectDir, file);
                const stats = await fs.promises.stat(filePath);
                
                if (stats.mtime.getTime() > mostRecentTime) {
                    mostRecentTime = stats.mtime.getTime();
                    mostRecent = file.replace('.jsonl', '');
                }
            }
            
            // Only trigger if changed and was modified recently
            const now = Date.now();
            if (mostRecent && 
                mostRecent !== this.lastActiveConversation && 
                now - mostRecentTime < 30000) { // Within last 30 seconds
                
                this.lastActiveConversation = mostRecent;
                console.log(`Active conversation detected: ${mostRecent}`);
                
                if (callback) {
                    callback({
                        sessionName: this.sessionName,
                        conversationId: mostRecent,
                        timestamp: new Date().toISOString()
                    });
                }
            }
        } catch (err) {
            console.error('Error finding active conversation:', err);
        }
    }

    // Stop monitoring
    stopMonitoring() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        
        for (const [path, watcher] of this.watchers) {
            watcher.close();
        }
        this.watchers.clear();
    }

    // Get conversation ID from tmux pane title (if Claude sets it)
    async getConversationFromTmux() {
        try {
            // Check if tmux pane title contains conversation ID
            const result = await execAsync(`tmux display-message -p -t ${this.sessionName} '#T' 2>/dev/null`);
            
            // Claude might set the pane title to include the conversation ID
            const match = result.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
            if (match) {
                return match[1];
            }
        } catch (err) {
            // Tmux command failed
        }
        
        return null;
    }
}

// Export for use in other modules
module.exports = ClaudeConversationMonitor;

// CLI interface
if (require.main === module) {
    const sessionName = process.argv[2];
    
    if (!sessionName) {
        console.error('Usage: claude-conversation-monitor.js <session-name>');
        process.exit(1);
    }
    
    const monitor = new ClaudeConversationMonitor(sessionName);
    
    // Track conversations in the session map
    const SimpleClaudeSessionTracker = require('./claude-session-tracker-simple.js');
    const tracker = new SimpleClaudeSessionTracker();
    
    tracker.init().then(() => {
        monitor.startMonitoring(async (info) => {
            console.log('Conversation change detected:', info);
            
            // Update the session map
            await tracker.trackConversation(info.sessionName, info.conversationId);
            console.log(`Updated tracking for ${info.sessionName} -> ${info.conversationId}`);
        });
        
        console.log('Monitoring started. Press Ctrl+C to stop.');
        
        // Handle shutdown
        process.on('SIGINT', () => {
            console.log('\nStopping monitor...');
            monitor.stopMonitoring();
            process.exit(0);
        });
    });
}