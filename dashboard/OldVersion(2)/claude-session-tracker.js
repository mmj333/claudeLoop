#!/usr/bin/env node

/*
 * Claude Session Tracker
 * Monitors and manages Claude conversation sessions for each loop
 */

const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

class ClaudeSessionTracker {
    constructor() {
        // Claude stores conversations in ~/.config/claude/conversations/
        this.conversationsDir = path.join(process.env.HOME, '.config', 'claude', 'conversations');
        this.sessionMapFile = path.join(__dirname, 'session-map.json');
        this.sessionMap = {};
    }

    async init() {
        try {
            // Load existing session map
            const data = await fs.readFile(this.sessionMapFile, 'utf8');
            this.sessionMap = JSON.parse(data);
        } catch (err) {
            // File doesn't exist, start fresh
            this.sessionMap = {};
        }
    }

    async saveSessionMap() {
        await fs.writeFile(this.sessionMapFile, JSON.stringify(this.sessionMap, null, 2));
    }

    // Find the most recent conversation file
    async findLatestConversation() {
        try {
            const files = await fs.readdir(this.conversationsDir);
            const jsonFiles = files.filter(f => f.endsWith('.json'));
            
            if (jsonFiles.length === 0) return null;

            // Get file stats and sort by modification time
            const fileStats = await Promise.all(
                jsonFiles.map(async (file) => {
                    const fullPath = path.join(this.conversationsDir, file);
                    const stats = await fs.stat(fullPath);
                    return { file, path: fullPath, mtime: stats.mtime };
                })
            );

            fileStats.sort((a, b) => b.mtime - a.mtime);
            return fileStats[0];
        } catch (err) {
            console.error('Error finding conversations:', err);
            return null;
        }
    }

    // Get conversation metadata
    async getConversationInfo(conversationPath) {
        try {
            const data = await fs.readFile(conversationPath, 'utf8');
            const conversation = JSON.parse(data);
            
            return {
                id: conversation.id || path.basename(conversationPath, '.json'),
                title: conversation.title || 'Untitled',
                messageCount: conversation.messages ? conversation.messages.length : 0,
                lastModified: (await fs.stat(conversationPath)).mtime,
                path: conversationPath
            };
        } catch (err) {
            console.error('Error reading conversation:', err);
            return null;
        }
    }

    // Track which conversation is active in a tmux session
    async trackActiveSession(sessionName) {
        const latestConv = await this.findLatestConversation();
        if (!latestConv) return null;

        const convInfo = await this.getConversationInfo(latestConv.path);
        if (!convInfo) return null;

        // Store the mapping
        this.sessionMap[sessionName] = {
            conversationId: convInfo.id,
            conversationPath: convInfo.path,
            title: convInfo.title,
            trackedAt: new Date().toISOString()
        };

        await this.saveSessionMap();
        return convInfo;
    }

    // Get the tracked conversation for a session
    async getTrackedConversation(sessionName) {
        return this.sessionMap[sessionName] || null;
    }

    // Monitor for conversation changes
    async monitorConversationChanges(sessionName, callback) {
        const tracked = this.sessionMap[sessionName];
        if (!tracked) return;

        let lastMtime = null;
        
        const checkForChanges = async () => {
            try {
                const stats = await fs.stat(tracked.conversationPath);
                if (!lastMtime || stats.mtime > lastMtime) {
                    lastMtime = stats.mtime;
                    const convInfo = await this.getConversationInfo(tracked.conversationPath);
                    if (callback) callback(convInfo);
                }
            } catch (err) {
                // Conversation file might have been deleted
                console.error('Error monitoring conversation:', err);
            }
        };

        // Check every 5 seconds
        const interval = setInterval(checkForChanges, 5000);
        checkForChanges(); // Initial check

        return () => clearInterval(interval);
    }

    // Find conversation by partial title or ID
    async findConversation(query) {
        try {
            const files = await fs.readdir(this.conversationsDir);
            const jsonFiles = files.filter(f => f.endsWith('.json'));
            
            for (const file of jsonFiles) {
                const fullPath = path.join(this.conversationsDir, file);
                const convInfo = await this.getConversationInfo(fullPath);
                
                if (convInfo && (
                    convInfo.id.includes(query) ||
                    convInfo.title.toLowerCase().includes(query.toLowerCase())
                )) {
                    return convInfo;
                }
            }
            
            return null;
        } catch (err) {
            console.error('Error searching conversations:', err);
            return null;
        }
    }

    // Get all conversations sorted by date
    async listConversations(limit = 10) {
        try {
            const files = await fs.readdir(this.conversationsDir);
            const jsonFiles = files.filter(f => f.endsWith('.json'));
            
            const conversations = await Promise.all(
                jsonFiles.map(async (file) => {
                    const fullPath = path.join(this.conversationsDir, file);
                    return await this.getConversationInfo(fullPath);
                })
            );

            return conversations
                .filter(c => c !== null)
                .sort((a, b) => b.lastModified - a.lastModified)
                .slice(0, limit);
        } catch (err) {
            console.error('Error listing conversations:', err);
            return [];
        }
    }

    // Create a conversation selector script for tmux
    async createConversationSelector(sessionName) {
        const conversations = await this.listConversations(20);
        const tracked = this.sessionMap[sessionName];
        
        let script = '#!/bin/bash\n\n';
        script += 'echo "Select a conversation to load:"\n';
        script += 'echo ""\n';
        
        conversations.forEach((conv, idx) => {
            const marker = (tracked && tracked.conversationId === conv.id) ? ' [CURRENT]' : '';
            script += `echo "${idx + 1}. ${conv.title}${marker}"\n`;
            script += `echo "   Messages: ${conv.messageCount}, Last modified: ${conv.lastModified.toLocaleString()}"\n`;
            script += 'echo ""\n';
        });
        
        script += 'read -p "Enter number (or press Enter for most recent): " choice\n';
        script += 'case $choice in\n';
        
        conversations.forEach((conv, idx) => {
            script += `  ${idx + 1}) echo "${conv.id}" ;;\n`;
        });
        
        script += `  *) echo "${conversations[0]?.id || ''}" ;;\n`;
        script += 'esac\n';
        
        const scriptPath = `/tmp/claude-conv-selector-${sessionName}.sh`;
        await fs.writeFile(scriptPath, script, { mode: 0o755 });
        
        return scriptPath;
    }
}

// Export for use in other modules
module.exports = ClaudeSessionTracker;

// CLI interface
if (require.main === module) {
    const tracker = new ClaudeSessionTracker();
    
    async function main() {
        await tracker.init();
        
        const command = process.argv[2];
        const sessionName = process.argv[3];
        
        switch (command) {
            case 'track':
                if (!sessionName) {
                    console.error('Usage: claude-session-tracker track <session-name>');
                    process.exit(1);
                }
                const info = await tracker.trackActiveSession(sessionName);
                console.log(JSON.stringify(info, null, 2));
                break;
                
            case 'get':
                if (!sessionName) {
                    console.error('Usage: claude-session-tracker get <session-name>');
                    process.exit(1);
                }
                const tracked = await tracker.getTrackedConversation(sessionName);
                console.log(JSON.stringify(tracked, null, 2));
                break;
                
            case 'list':
                const conversations = await tracker.listConversations();
                console.log(JSON.stringify(conversations, null, 2));
                break;
                
            case 'find':
                const query = process.argv[3];
                if (!query) {
                    console.error('Usage: claude-session-tracker find <query>');
                    process.exit(1);
                }
                const found = await tracker.findConversation(query);
                console.log(JSON.stringify(found, null, 2));
                break;
                
            default:
                console.log('Usage: claude-session-tracker <command> [args]');
                console.log('Commands:');
                console.log('  track <session>  - Track the current conversation for a session');
                console.log('  get <session>    - Get tracked conversation for a session');
                console.log('  list             - List recent conversations');
                console.log('  find <query>     - Find conversation by title or ID');
        }
    }
    
    main().catch(console.error);
}