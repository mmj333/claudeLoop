#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const readline = require('readline');
const { createReadStream } = require('fs');

class ConversationTreeScanner {
    constructor() {
        this.cacheFile = path.join(os.homedir(), '.claude', 'conversation-tree-cache.json');
        this.projectsDir = path.join(os.homedir(), '.claude', 'projects');
    }

    // Get list of conversation IDs from files
    async getConversationIds() {
        const allFiles = await this.getAllConversationFiles();
        return allFiles.map(f => path.basename(f, '.jsonl'));
    }

    // Read first N lines of a file
    async readFirstLines(filePath, numLines = 5) {
        const lines = [];
        const fileStream = createReadStream(filePath);
        const rl = readline.createInterface({
            input: fileStream,
            crlfDelay: Infinity
        });

        for await (const line of rl) {
            lines.push(line);
            if (lines.length >= numLines) {
                rl.close();
                break;
            }
        }

        fileStream.destroy();
        return lines;
    }

    // Extract conversation metadata from file
    async scanConversationFile(filePath) {
        try {
            const conversationId = path.basename(filePath, '.jsonl');
            const stats = await fs.stat(filePath);
            const lines = await this.readFirstLines(filePath, 10);
            
            let parentId = null;
            let timestamp = null;
            let cwd = null;
            let isSidechain = false;
            let isCompactSummary = false;
            let firstUserMessage = null;
            let messageCount = 0;

            // Parse first few lines to get metadata
            for (const line of lines) {
                try {
                    const data = JSON.parse(line);
                    messageCount++;
                    
                    // Extract metadata from first message with these fields
                    if (!parentId && data.parentUuid) {
                        parentId = data.parentUuid;
                    }
                    if (!timestamp && data.timestamp) {
                        timestamp = data.timestamp;
                    }
                    if (!cwd && data.cwd) {
                        cwd = data.cwd;
                    }
                    if (data.isSidechain !== undefined) {
                        isSidechain = data.isSidechain;
                    }
                    if (data.isCompactSummary !== undefined) {
                        isCompactSummary = data.isCompactSummary;
                    }
                    
                    // Capture first user message as potential title
                    if (!firstUserMessage && data.type === 'user' && data.message) {
                        firstUserMessage = data.message.substring(0, 100);
                    }
                } catch (e) {
                    // Skip malformed lines
                }
            }

            // Count total messages (approximate for large files)
            const content = await fs.readFile(filePath, 'utf8');
            messageCount = content.split('\n').filter(line => line.trim()).length;

            return {
                id: conversationId,
                parentId: parentId,
                timestamp: timestamp || stats.birthtime.toISOString(),
                lastModified: stats.mtime.toISOString(),
                cwd: cwd || 'unknown',
                isSidechain: isSidechain,
                isCompactSummary: isCompactSummary,
                messageCount: messageCount,
                firstUserMessage: firstUserMessage,
                filePath: filePath,
                children: [] // Will be populated later
            };
        } catch (error) {
            console.error(`Error scanning ${filePath}:`, error);
            return null;
        }
    }

    // Get all conversation files
    async getAllConversationFiles() {
        const files = [];
        
        try {
            const projects = await fs.readdir(this.projectsDir);
            
            for (const project of projects) {
                const projectPath = path.join(this.projectsDir, project);
                const stat = await fs.stat(projectPath);
                
                if (stat.isDirectory()) {
                    const projectFiles = await fs.readdir(projectPath);
                    const jsonlFiles = projectFiles
                        .filter(f => f.endsWith('.jsonl'))
                        .map(f => path.join(projectPath, f));
                    files.push(...jsonlFiles);
                }
            }
        } catch (error) {
            console.error('Error reading projects directory:', error);
        }
        
        return files;
    }

    // Load cache from disk
    async loadCache() {
        try {
            const data = await fs.readFile(this.cacheFile, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            // Return empty cache if doesn't exist
            return {
                lastScanTimestamp: null,
                knownIds: [], // Just track IDs, not hashes
                conversations: {}
            };
        }
    }

    // Save cache to disk
    async saveCache(cache) {
        try {
            // Ensure directory exists
            const dir = path.dirname(this.cacheFile);
            await fs.mkdir(dir, { recursive: true });
            
            await fs.writeFile(this.cacheFile, JSON.stringify(cache, null, 2));
            return true;
        } catch (error) {
            console.error('Error saving cache:', error);
            return false;
        }
    }

    // Perform incremental scan
    async incrementalScan() {
        console.log('Starting incremental conversation scan...');
        const startTime = Date.now();
        
        const cache = await this.loadCache();
        const allFiles = await this.getAllConversationFiles();
        
        // Get current IDs from filesystem
        const currentIds = new Set(allFiles.map(f => path.basename(f, '.jsonl')));
        const cachedIds = new Set(cache.knownIds || Object.keys(cache.conversations));
        
        // Find new conversations (in filesystem but not in cache)
        const newIds = [...currentIds].filter(id => !cachedIds.has(id));
        
        // Find deleted conversations (in cache but not in filesystem)
        const deletedIds = [...cachedIds].filter(id => !currentIds.has(id));
        
        // Only scan NEW conversations
        const updates = [];
        for (const newId of newIds) {
            const filePath = allFiles.find(f => path.basename(f, '.jsonl') === newId);
            if (filePath) {
                console.log(`Scanning new conversation: ${newId}...`);
                const convData = await this.scanConversationFile(filePath);
                
                if (convData) {
                    updates.push(convData);
                    cache.conversations[newId] = convData;
                }
            }
        }
        
        // Remove deleted conversations
        for (const deletedId of deletedIds) {
            console.log(`Removing deleted conversation: ${deletedId}`);
            delete cache.conversations[deletedId];
        }
        
        // Update known IDs list
        cache.knownIds = [...currentIds];
        
        // Rebuild parent-child relationships for ALL conversations
        // (needed because a new conversation might be a child of an existing one)
        for (const id in cache.conversations) {
            cache.conversations[id].children = [];
        }
        
        for (const id in cache.conversations) {
            const conv = cache.conversations[id];
            if (conv.parentId && cache.conversations[conv.parentId]) {
                cache.conversations[conv.parentId].children.push(id);
            }
        }
        
        // Update timestamp
        cache.lastScanTimestamp = new Date().toISOString();
        
        // Save updated cache
        await this.saveCache(cache);
        
        const elapsed = Date.now() - startTime;
        console.log(`Scan complete in ${elapsed}ms`);
        console.log(`New: ${newIds.length}, Deleted: ${deletedIds.length}, Total: ${Object.keys(cache.conversations).length}`);
        
        return {
            cache: cache,
            updatedCount: newIds.length,
            deletedCount: deletedIds.length,
            totalCount: Object.keys(cache.conversations).length
        };
    }

    // Force full rescan
    async fullScan() {
        console.log('Starting full conversation scan...');
        
        // Clear cache to force full scan
        await this.saveCache({
            lastScanTimestamp: null,
            knownIds: [],
            conversations: {}
        });
        
        return await this.incrementalScan();
    }

    // Get conversation tree from cache (no scanning)
    async getCachedTree() {
        const cache = await this.loadCache();
        return cache;
    }
    
    // Get conversation tree with fresh scan
    async getFreshTree() {
        const result = await this.incrementalScan();
        return result.cache;
    }
    
    // Get conversation tree (smart mode - scan only if needed)
    async getConversationTree(forceRefresh = false) {
        if (forceRefresh) {
            return await this.getFreshTree();
        }
        // Otherwise just return cached data
        return await this.getCachedTree();
    }

    // Build tree structure for UI
    buildTreeStructure(conversations) {
        const roots = [];
        const convMap = {};
        
        // Create map for quick lookup
        for (const id in conversations) {
            convMap[id] = { ...conversations[id] };
        }
        
        // Find root conversations (no parent)
        for (const id in convMap) {
            if (!convMap[id].parentId || !convMap[convMap[id].parentId]) {
                roots.push(convMap[id]);
            }
        }
        
        // Sort roots by timestamp
        roots.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        
        return roots;
    }

    // Get conversation with its lineage
    async getConversationLineage(conversationId) {
        const cache = await this.getConversationTree();
        const lineage = [];
        
        let current = cache.conversations[conversationId];
        while (current) {
            lineage.unshift(current);
            current = current.parentId ? cache.conversations[current.parentId] : null;
        }
        
        return lineage;
    }
}

// Export for use in other modules
module.exports = ConversationTreeScanner;

// CLI interface
if (require.main === module) {
    const scanner = new ConversationTreeScanner();
    
    const command = process.argv[2];
    
    async function main() {
        switch (command) {
            case 'scan':
                await scanner.incrementalScan();
                break;
                
            case 'full':
                await scanner.fullScan();
                break;
                
            case 'tree':
                const cache = await scanner.getConversationTree();
                const tree = scanner.buildTreeStructure(cache.conversations);
                console.log(JSON.stringify(tree, null, 2));
                break;
                
            case 'lineage':
                const convId = process.argv[3];
                if (!convId) {
                    console.error('Usage: conversation-tree-scanner.js lineage <conversation-id>');
                    process.exit(1);
                }
                const lineage = await scanner.getConversationLineage(convId);
                console.log(JSON.stringify(lineage, null, 2));
                break;
                
            default:
                console.log('Usage: conversation-tree-scanner.js [scan|full|tree|lineage <id>]');
                console.log('  scan    - Incremental scan (only changed files)');
                console.log('  full    - Full rescan of all conversations');
                console.log('  tree    - Display conversation tree structure');
                console.log('  lineage - Show lineage of specific conversation');
        }
    }
    
    main().catch(console.error);
}