#!/usr/bin/env node

/*
 * Simple Claude Session Tracker
 * Reads session data directly from Claude's .claude.json file
 */

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { readFirstLine } = require('./efficient-line-reader');
const pathCache = require('./claude-project-path-cache');
const conversationNamer = require('./conversation-names');

class SimpleClaudeSessionTracker {
    constructor() {
        this.claudeConfigFile = path.join(os.homedir(), '.claude.json');
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

    // Get project path for current directory
    getProjectPath(directory = null) {
        const cwd = directory || process.cwd();
        // Convert to Claude's project path format
        // Claude only replaces slashes with dashes, and underscores with dashes
        // All other characters (spaces, dots, etc.) are kept as-is
        return cwd.replace(/\//g, '-').replace(/_/g, '-');
    }
    
    // Convert Claude's project path back to human-readable directory
    projectPathToDirectory(projectPath, needsVerification = false) {
        // This is a best-effort conversion since we can't know if a dash was originally
        // a slash or underscore. 
        
        // For now, we'll just convert all dashes back to slashes
        // This won't be perfect for paths with underscores, but it's the best we can do
        // without maintaining a mapping
        let result = projectPath.replace(/^-/, '/').replace(/-/g, '/');
        
        // Handle some known patterns where underscores are likely
        const underscorePatterns = [
            { pattern: /\/Computers\/Plus\/Repair/g, replacement: '/Computers_Plus_Repair' },
            { pattern: /\/Infiniquest\/old/g, replacement: '/_Infiniquest_old' }
        ];
        
        underscorePatterns.forEach(({ pattern, replacement }) => {
            result = result.replace(pattern, replacement);
        });
        
        return result;
    }
    
    // Check if a project path might have ambiguity (contains segments that could have been underscores)
    hasPathAmbiguity(projectPath) {
        // Count dashes that aren't at the beginning
        const dashCount = (projectPath.match(/-/g) || []).length - 1; // -1 for leading dash
        
        // If there are more dashes than expected for a simple path, there might be ambiguity
        // A simple path like /home/michael/InfiniQuest would have 3 dashes after encoding
        // If we see more, it might contain underscores or dashes in directory names
        
        // Check for known patterns that suggest underscores
        const suspiciousPatterns = [
            /-Plus-/,
            /-old-/,
            /-copy-/,
            /-backup-/,
            /-test-/,
            /-temp-/,
            /-tmp-/
        ];
        
        return suspiciousPatterns.some(pattern => pattern.test(projectPath));
    }

    // Read Claude's conversations from project directory
    async getClaudeConversations() {
        try {
            const projectPath = this.getProjectPath();
            const projectDir = path.join(os.homedir(), '.claude', 'projects', projectPath);
            
            // Check if project directory exists
            try {
                await fs.access(projectDir);
            } catch {
                return [];
            }
            
            // Read all JSONL files in the project directory
            const files = await fs.readdir(projectDir);
            const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
            
            const conversations = [];
            
            for (const file of jsonlFiles) {
                const sessionId = file.replace('.jsonl', '');
                const filePath = path.join(projectDir, file);
                const stats = await fs.stat(filePath);
                
                // Read the first and last lines to get conversation info
                const content = await fs.readFile(filePath, 'utf8');
                const lines = content.trim().split('\n').filter(l => l.trim());
                
                if (lines.length > 0) {
                    try {
                        // Parse first message to get initial info
                        const firstMsg = JSON.parse(lines[0]);
                        let title = 'Untitled';
                        let projectPath = process.cwd(); // Default to current directory
                        
                        // Extract the actual working directory from the cwd field
                        if (firstMsg.cwd) {
                            projectPath = firstMsg.cwd;
                        }
                        
                        // Try to get a title from the first user message
                        for (let i = 0; i < Math.min(5, lines.length); i++) {
                            const msg = JSON.parse(lines[i]);
                            if (msg.userType === 'external' && msg.message && msg.message.content) {
                                const content = msg.message.content[0];
                                if (content && content.text) {
                                    title = content.text.substring(0, 100).replace(/\n/g, ' ').trim();
                                    if (title.length > 50) title = title.substring(0, 50) + '...';
                                    break;
                                }
                            }
                        }
                        
                        conversations.push({
                            id: sessionId,
                            title: title,
                            lastModified: stats.mtime,
                            messageCount: lines.length,
                            projectPath: projectPath,
                            filePath: filePath
                        });
                    } catch (err) {
                        // Skip malformed files
                        console.error(`Error parsing ${file}:`, err.message);
                    }
                }
            }
            
            return conversations;
        } catch (err) {
            console.error('Error reading Claude conversations:', err);
            return [];
        }
    }

    // Get the most recent conversation
    async getLatestConversation() {
        const conversations = await this.getClaudeConversations();
        if (conversations.length === 0) return null;
        
        // Sort by last modified date
        conversations.sort((a, b) => b.lastModified - a.lastModified);
        return conversations[0];
    }

    // Track a conversation for a specific session
    async trackConversation(sessionName, conversationId) {
        const conversations = await this.getClaudeConversations();
        const conv = conversations.find(c => c.id === conversationId);
        
        if (conv) {
            this.sessionMap[sessionName] = {
                conversationId: conv.id,
                title: conv.title,
                projectPath: conv.projectPath,
                trackedAt: new Date().toISOString()
            };
            await this.saveSessionMap();
            return conv;
        }
        
        return null;
    }

    // Auto-track the most recent conversation for a session
    async trackActiveSession(sessionName) {
        const latest = await this.getLatestConversation();
        if (!latest) return null;
        
        this.sessionMap[sessionName] = {
            conversationId: latest.id,
            title: latest.title,
            projectPath: latest.projectPath,
            trackedAt: new Date().toISOString()
        };
        
        await this.saveSessionMap();
        return latest;
    }

    // Get the tracked conversation for a session
    async getTrackedConversation(sessionName) {
        return this.sessionMap[sessionName] || null;
    }

    // List all conversations
    async listConversations(limit = 20) {
        const conversations = await this.getClaudeConversations();
        return conversations
            .sort((a, b) => b.lastModified - a.lastModified)
            .slice(0, limit);
    }
    
    // Get conversations from all projects, grouped by directory
    async getAllProjectConversations(includeCustomNames = true) {
        const projectsDir = path.join(os.homedir(), '.claude', 'projects');
        const result = {};
        
        try {
            // Get all project directories
            const projectDirs = await fs.readdir(projectsDir);
            
            // Load custom names if requested
            let customNames = {};
            if (includeCustomNames) {
                customNames = await conversationNamer.getAllNames();
            }
            
            for (const projectDir of projectDirs) {
                if (!projectDir.startsWith('-')) continue;
                
                const fullPath = path.join(projectsDir, projectDir);
                const stats = await fs.stat(fullPath);
                
                if (!stats.isDirectory()) continue;
                
                // Check if we have this path cached
                let actualDirectory = pathCache.get(projectDir);
                let needsPathResolution = false;
                
                if (!actualDirectory) {
                    // Try to decode it without reading files first
                    actualDirectory = this.projectPathToDirectory(projectDir);
                    
                    // Check if this path might have ambiguity
                    if (this.hasPathAmbiguity(projectDir)) {
                        needsPathResolution = true;
                    } else {
                        // No ambiguity, cache the decoded path
                        pathCache.set(projectDir, actualDirectory);
                    }
                }
                
                try {
                    // Read conversations from this project
                    const files = await fs.readdir(fullPath);
                    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
                    
                    if (jsonlFiles.length === 0) continue;
                    
                    const conversations = [];
                    
                    // If we need path resolution, read just the first file
                    if (needsPathResolution && jsonlFiles.length > 0) {
                        const firstFile = jsonlFiles[0];
                        const firstFilePath = path.join(fullPath, firstFile);
                        const firstLineStr = await readFirstLine(firstFilePath);
                        
                        if (firstLineStr) {
                            try {
                                const firstMsg = JSON.parse(firstLineStr);
                                if (firstMsg.cwd) {
                                    actualDirectory = firstMsg.cwd;
                                    // Cache this for future use
                                    pathCache.set(projectDir, actualDirectory);
                                }
                            } catch (err) {
                                // Use the decoded path if we can't parse
                            }
                        }
                    }
                    
                    // Now process all files without reading them
                    for (const file of jsonlFiles) {
                        const sessionId = file.replace('.jsonl', '');
                        const filePath = path.join(fullPath, file);
                        const fileStats = await fs.stat(filePath);
                        
                        // Get custom name if available
                        let title = customNames[sessionId]?.name || null;
                        
                        // Format file size nicely
                        let sizeStr = '';
                        const size = fileStats.size;
                        if (size < 1024) {
                            sizeStr = size + 'B';
                        } else if (size < 1024 * 1024) {
                            sizeStr = Math.round(size / 1024) + 'KB';
                        } else {
                            sizeStr = Math.round(size / (1024 * 1024)) + 'MB';
                        }
                        
                        conversations.push({
                            id: sessionId,
                            title: title,
                            customName: title, // Keep track if it's custom
                            lastModified: fileStats.mtime,
                            fileSize: size,
                            fileSizeStr: sizeStr,
                            projectPath: actualDirectory,
                            filePath: filePath
                        });
                    }
                    
                    if (conversations.length > 0) {
                        // Sort by last modified within each project
                        conversations.sort((a, b) => b.lastModified - a.lastModified);
                        
                        // Group by actual directory path
                        if (!result[actualDirectory]) {
                            result[actualDirectory] = [];
                        }
                        result[actualDirectory].push(...conversations);
                    }
                    
                } catch (err) {
                    // Skip projects we can't read
                }
            }
            
            return result;
        } catch (err) {
            console.error('Error reading all projects:', err);
            return {};
        }
    }

    // Find conversation by title or ID
    async findConversation(query) {
        const conversations = await this.getClaudeConversations();
        const lowerQuery = query.toLowerCase();
        
        return conversations.find(conv => 
            conv.id.includes(query) ||
            conv.title.toLowerCase().includes(lowerQuery)
        );
    }

    // Get conversation by exact ID
    async getConversationById(id) {
        const conversations = await this.getClaudeConversations();
        return conversations.find(conv => conv.id === id);
    }
}

// Export for use in other modules
module.exports = SimpleClaudeSessionTracker;

// CLI interface
if (require.main === module) {
    const tracker = new SimpleClaudeSessionTracker();
    
    async function main() {
        await tracker.init();
        
        const command = process.argv[2];
        const sessionName = process.argv[3];
        
        switch (command) {
            case 'track':
                if (!sessionName) {
                    console.error('Usage: claude-session-tracker-simple track <session-name>');
                    process.exit(1);
                }
                const info = await tracker.trackActiveSession(sessionName);
                console.log(JSON.stringify(info, null, 2));
                break;
                
            case 'get':
                if (!sessionName) {
                    console.error('Usage: claude-session-tracker-simple get <session-name>');
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
                    console.error('Usage: claude-session-tracker-simple find <query>');
                    process.exit(1);
                }
                const found = await tracker.findConversation(query);
                console.log(JSON.stringify(found, null, 2));
                break;
                
            case 'latest':
                const latest = await tracker.getLatestConversation();
                console.log(JSON.stringify(latest, null, 2));
                break;
                
            default:
                console.log('Usage: claude-session-tracker-simple <command> [args]');
                console.log('Commands:');
                console.log('  track <session>  - Track the current conversation for a session');
                console.log('  get <session>    - Get tracked conversation for a session');
                console.log('  list             - List recent conversations');
                console.log('  find <query>     - Find conversation by title or ID');
                console.log('  latest           - Get the most recent conversation');
        }
    }
    
    main().catch(console.error);
}