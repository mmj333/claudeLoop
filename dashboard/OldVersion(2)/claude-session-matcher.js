#!/usr/bin/env node

/*
 * Claude Session Matcher
 * Matches Claude conversations to loop sessions by comparing messages
 */

const fs = require('fs').promises;
const path = require('path');
const os = require('os');

class ClaudeSessionMatcher {
    constructor() {
        this.messageCache = new Map(); // Track messages sent by each loop
        this.sessionMapFile = path.join(__dirname, 'session-map.json');
        this.sessionMap = {};
    }

    async init() {
        try {
            const data = await fs.readFile(this.sessionMapFile, 'utf8');
            this.sessionMap = JSON.parse(data);
        } catch (err) {
            this.sessionMap = {};
        }
    }

    // Record a message sent by a loop
    recordLoopMessage(sessionName, message, timestamp = new Date()) {
        if (!this.messageCache.has(sessionName)) {
            this.messageCache.set(sessionName, []);
        }
        
        const messages = this.messageCache.get(sessionName);
        messages.push({
            message: message.trim(),
            timestamp: timestamp,
            normalized: this.normalizeMessage(message)
        });
        
        // Keep only last 10 messages per session
        if (messages.length > 10) {
            messages.shift();
        }
    }

    // Normalize message for comparison (remove extra whitespace, etc)
    normalizeMessage(message) {
        return message
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase()
            .substring(0, 200); // Compare first 200 chars
    }

    // Get project directory for a working directory
    getProjectDir(workingDir) {
        const projectPath = workingDir.replace(/\//g, '-');
        return path.join(os.homedir(), '.claude', 'projects', projectPath);
    }

    // Read recent messages from a conversation file
    async getRecentMessagesFromConversation(filePath, limit = 5) {
        try {
            const content = await fs.readFile(filePath, 'utf8');
            const lines = content.trim().split('\n').filter(l => l.trim());
            
            // Get the last N user messages
            const userMessages = [];
            for (let i = lines.length - 1; i >= 0 && userMessages.length < limit; i--) {
                try {
                    const entry = JSON.parse(lines[i]);
                    if (entry.userType === 'external' && entry.message && entry.message.content) {
                        const messageContent = entry.message.content
                            .map(c => c.text || '')
                            .join(' ')
                            .trim();
                        
                        if (messageContent) {
                            userMessages.push({
                                message: messageContent,
                                timestamp: new Date(entry.timestamp),
                                normalized: this.normalizeMessage(messageContent)
                            });
                        }
                    }
                } catch (e) {
                    // Skip malformed lines
                }
            }
            
            return userMessages.reverse(); // Return in chronological order
        } catch (err) {
            return [];
        }
    }

    // Match conversations to sessions based on messages
    async matchConversationsToSessions(workingDir) {
        const projectDir = this.getProjectDir(workingDir);
        const matches = new Map();
        
        try {
            // Check if project directory exists
            try {
                await fs.access(projectDir);
            } catch {
                // Project directory doesn't exist, skip
                return matches;
            }
            
            // Get all conversation files
            const files = await fs.readdir(projectDir);
            const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
            
            // For each conversation file
            for (const file of jsonlFiles) {
                const conversationId = file.replace('.jsonl', '');
                const filePath = path.join(projectDir, file);
                
                // Skip if file hasn't been modified recently (within last hour)
                const stats = await fs.stat(filePath);
                const ageMs = Date.now() - stats.mtime.getTime();
                if (ageMs > 3600000) continue; // Skip files older than 1 hour
                
                // Get recent messages from the conversation
                const convMessages = await this.getRecentMessagesFromConversation(filePath);
                if (convMessages.length === 0) continue;
                
                // Check each session's messages
                let bestMatch = null;
                let bestScore = 0;
                
                for (const [sessionName, loopMessages] of this.messageCache.entries()) {
                    if (loopMessages.length === 0) continue;
                    
                    // Calculate match score
                    let score = 0;
                    
                    // Check if any loop messages appear in conversation
                    for (const loopMsg of loopMessages) {
                        for (const convMsg of convMessages) {
                            // Check for exact match (normalized)
                            if (loopMsg.normalized === convMsg.normalized) {
                                score += 100;
                            }
                            // Check for partial match
                            else if (convMsg.normalized.includes(loopMsg.normalized.substring(0, 50))) {
                                score += 50;
                            }
                            
                            // Bonus points for close timestamps (within 30 seconds)
                            const timeDiff = Math.abs(loopMsg.timestamp - convMsg.timestamp);
                            if (timeDiff < 30000) {
                                score += 20;
                            }
                        }
                    }
                    
                    if (score > bestScore) {
                        bestScore = score;
                        bestMatch = sessionName;
                    }
                }
                
                // If we have a confident match
                if (bestMatch && bestScore >= 100) {
                    matches.set(conversationId, {
                        sessionName: bestMatch,
                        confidence: bestScore,
                        lastModified: stats.mtime
                    });
                    
                    // Update session map
                    this.sessionMap[bestMatch] = {
                        conversationId: conversationId,
                        workingDirectory: workingDir,
                        matchedAt: new Date().toISOString(),
                        confidence: bestScore
                    };
                }
            }
            
            // Save updated session map
            await fs.writeFile(this.sessionMapFile, JSON.stringify(this.sessionMap, null, 2));
            
            return matches;
        } catch (err) {
            console.error('Error matching conversations:', err);
            return new Map();
        }
    }

    // Get tracked conversation for a session
    getTrackedConversation(sessionName) {
        return this.sessionMap[sessionName] || null;
    }

    // Manually set a conversation for a session
    async setSessionConversation(sessionName, conversationId, workingDir) {
        this.sessionMap[sessionName] = {
            conversationId: conversationId,
            workingDirectory: workingDir,
            setAt: new Date().toISOString(),
            manual: true
        };
        
        await fs.writeFile(this.sessionMapFile, JSON.stringify(this.sessionMap, null, 2));
    }
}

// Export for use in dashboard
module.exports = ClaudeSessionMatcher;

// CLI interface
if (require.main === module) {
    const matcher = new ClaudeSessionMatcher();
    
    async function main() {
        await matcher.init();
        
        const command = process.argv[2];
        
        switch (command) {
            case 'match':
                const workingDir = process.argv[3] || process.cwd();
                
                // Add some test messages for demonstration
                matcher.recordLoopMessage('claude-loop4', 'Please implement the text refactoring described in');
                matcher.recordLoopMessage('claude-loop6', 'Please continue with what you\'re dining');
                
                const matches = await matcher.matchConversationsToSessions(workingDir);
                console.log('Matches found:');
                for (const [convId, info] of matches.entries()) {
                    console.log(`  ${convId} -> ${info.sessionName} (confidence: ${info.confidence})`);
                }
                break;
                
            case 'get':
                const sessionName = process.argv[3];
                if (!sessionName) {
                    console.error('Usage: claude-session-matcher get <session-name>');
                    process.exit(1);
                }
                const tracked = matcher.getTrackedConversation(sessionName);
                console.log(JSON.stringify(tracked, null, 2));
                break;
                
            default:
                console.log('Usage: claude-session-matcher <command> [args]');
                console.log('Commands:');
                console.log('  match [dir]     - Match conversations to sessions');
                console.log('  get <session>   - Get tracked conversation for session');
        }
    }
    
    main().catch(console.error);
}