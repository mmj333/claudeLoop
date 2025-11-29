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

    // Extract conversation metadata - can optionally read file contents
    async scanConversationFile(fileInfo, readContents = false) {
        try {
            const filePath = typeof fileInfo === 'string' ? fileInfo : fileInfo.path;
            const projectFolder = typeof fileInfo === 'object' ? fileInfo.projectFolder : null;
            const conversationId = path.basename(filePath, '.jsonl');
            const stats = await fs.stat(filePath);
            
            // Derive CWD from project folder name
            let cwd = 'unknown';
            if (projectFolder) {
                // Convert folder name like "-home-michael-InfiniQuest" to "/home/michael/InfiniQuest"
                cwd = projectFolder.replace(/^-/, '/').replace(/-/g, '/');
            }

            const metadata = {
                id: conversationId,
                parentId: null,
                timestamp: stats.birthtime.toISOString(),
                lastModified: stats.mtime.toISOString(),
                fileSize: stats.size,
                cwd: cwd,
                isSidechain: false,
                isCompactSummary: false,
                messageCount: 0,
                firstUserMessage: null,
                filePath: filePath,
                children: []
            };

            // If requested, read the file contents to extract more metadata
            if (readContents) {
                try {
                    const content = await fs.readFile(filePath, 'utf8');
                    const lines = content.trim().split('\n').filter(line => line.trim());
                    
                    metadata.messageCount = lines.length;
                    
                    // Track the leafUuid of this conversation (last seen)
                    let conversationLeafUuid = null;
                    let parentLeafUuid = null;
                    let summaryText = null;
                    
                    // Find first user message and parent ID
                    for (let i = 0; i < lines.length; i++) {
                        try {
                            const msg = JSON.parse(lines[i]);
                            
                            // Track leafUuid for this conversation
                            if (msg.leafUuid) {
                                conversationLeafUuid = msg.leafUuid;
                            }
                            
                            // Extract summary text as fallback title (store full text)
                            if (!summaryText && msg.type === 'summary' && msg.summary) {
                                summaryText = msg.summary; // Don't truncate - store full summary
                            }
                            
                            // Extract first user message for title (preferred over summary)
                            if (!metadata.firstUserMessage && msg.type === 'user') {
                                // Handle different message formats
                                let content = null;
                                
                                // Format 1: msg.message.content (nested object)
                                if (msg.message && typeof msg.message === 'object' && msg.message.content) {
                                    content = msg.message.content;
                                }
                                // Format 2: msg.content (direct)
                                else if (msg.content) {
                                    content = msg.content;
                                }
                                // Format 3: msg.message (string)
                                else if (msg.message && typeof msg.message === 'string') {
                                    content = msg.message;
                                }
                                
                                // Extract useful content from boilerplate compact continuation messages
                                if (content && content.startsWith('This session is being continued from a previous conversation')) {
                                    // Try to extract what comes after the boilerplate
                                    // Look for "Analysis:" or "Summary:" or just take what's after the first period
                                    const analysisMatch = content.match(/Analysis:\s*(.+?)(?:Summary:|$)/s);
                                    const summaryMatch = content.match(/Summary:\s*(.+?)(?:Analysis:|$)/s);
                                    
                                    if (analysisMatch && analysisMatch[1]) {
                                        content = analysisMatch[1].trim(); // Get full analysis section - no truncation
                                    } else if (summaryMatch && summaryMatch[1]) {
                                        content = summaryMatch[1].trim(); // Get full summary section - no truncation
                                    } else {
                                        // Just skip the boilerplate sentence and take what comes after
                                        const parts = content.split('\n');
                                        if (parts.length > 1) {
                                            content = parts.slice(1).join('\n').trim(); // Get full content - no truncation
                                        } else {
                                            content = null; // Nothing useful found
                                        }
                                    }
                                }
                                
                                if (content) {
                                    // Store the full content, don't truncate
                                    metadata.firstUserMessage = content;
                                }
                            }
                            
                            // Check if this is a fork/continuation (first message is summary with parent leafUuid)
                            if (i === 0 && msg.type === 'summary' && msg.leafUuid) {
                                // This conversation started from a parent
                                parentLeafUuid = msg.leafUuid;
                            }
                            
                            // Check for compact summary indicator
                            if (msg.content && typeof msg.content === 'string' && 
                                msg.content.includes('This session is being continued from a previous conversation')) {
                                metadata.isCompactSummary = true;
                            }
                        } catch (e) {
                            // Skip malformed JSON lines
                        }
                    }
                    
                    // Store summary separately if we have it
                    if (summaryText) {
                        metadata.summary = summaryText;
                    }
                    
                    // Use summary as title if no user message found OR if it's a compact summary
                    // (summaries are better than boilerplate for compacted conversations)
                    if (!metadata.firstUserMessage && summaryText) {
                        metadata.firstUserMessage = summaryText;
                    }
                    // If we detected it's a compact summary but still have boilerplate, prefer the summary
                    if (metadata.isCompactSummary && summaryText && metadata.firstUserMessage && 
                        metadata.firstUserMessage.includes('continued from a previous')) {
                        metadata.firstUserMessage = summaryText;
                    }
                    
                    // Final cleanup: remove any remaining boilerplate from firstUserMessage
                    if (metadata.firstUserMessage && metadata.firstUserMessage.includes('This session is being continued')) {
                        const cleanedUp = metadata.firstUserMessage.replace(/This session is being continued from a previous conversation[^.]*\.\s*/g, '').trim();
                        if (cleanedUp) {
                            metadata.firstUserMessage = cleanedUp;
                        }
                    }
                    
                    // Store both UUIDs for later parent-child mapping
                    metadata.leafUuid = conversationLeafUuid;
                    metadata.parentLeafUuid = parentLeafUuid;
                    
                } catch (readError) {
                    console.error(`Error reading contents of ${filePath}:`, readError);
                    // Continue with basic metadata even if reading fails
                }
            }

            return metadata;
        } catch (error) {
            console.error(`Error scanning ${typeof fileInfo === 'string' ? fileInfo : fileInfo.path}:`, error);
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
                        .map(f => ({
                            path: path.join(projectPath, f),
                            projectFolder: project
                        }));
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
        const currentIds = new Set(allFiles.map(f => {
            const filePath = typeof f === 'string' ? f : f.path;
            return path.basename(filePath, '.jsonl');
        }));
        const cachedIds = new Set(cache.knownIds || Object.keys(cache.conversations));
        
        // Find new conversations (in filesystem but not in cache)
        const newIds = [...currentIds].filter(id => !cachedIds.has(id));
        
        // Find deleted conversations (in cache but not in filesystem)
        const deletedIds = [...cachedIds].filter(id => !currentIds.has(id));
        
        // Update all conversations with correct CWD from folder names
        for (const fileInfo of allFiles) {
            const filePath = typeof fileInfo === 'string' ? fileInfo : fileInfo.path;
            const projectFolder = typeof fileInfo === 'object' ? fileInfo.projectFolder : null;
            const convId = path.basename(filePath, '.jsonl');
            
            // Update CWD for all conversations
            if (projectFolder) {
                const cwd = projectFolder.replace(/^-/, '/').replace(/-/g, '/');
                if (cache.conversations[convId]) {
                    cache.conversations[convId].cwd = cwd;
                    // Also update file size while we're at it
                    const stats = await fs.stat(filePath);
                    cache.conversations[convId].fileSize = stats.size;
                    cache.conversations[convId].lastModified = stats.mtime.toISOString();
                }
            }
        }
        
        // Only scan NEW conversations
        const updates = [];
        for (const newId of newIds) {
            const fileInfo = allFiles.find(f => {
                const filePath = typeof f === 'string' ? f : f.path;
                return path.basename(filePath, '.jsonl') === newId;
            });
            if (fileInfo) {
                console.log(`Scanning new conversation: ${newId}...`);
                const convData = await this.scanConversationFile(fileInfo);
                
                if (convData) {
                    // Merge with any existing cache data
                    if (cache.conversations[newId]) {
                        convData.parentId = cache.conversations[newId].parentId || convData.parentId;
                        convData.messageCount = cache.conversations[newId].messageCount || convData.messageCount;
                        convData.firstUserMessage = cache.conversations[newId].firstUserMessage || convData.firstUserMessage;
                    }
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

    // Force full rescan with file content reading
    async fullScan() {
        console.log('Starting full conversation scan with content extraction...');
        const startTime = Date.now();
        
        const cache = await this.loadCache();
        const allFiles = await this.getAllConversationFiles();
        
        // Load conversation names
        const namesPath = path.join(__dirname, 'conversation-names.json');
        let customNames = {};
        try {
            const namesData = await fs.readFile(namesPath, 'utf8');
            customNames = JSON.parse(namesData);
        } catch (e) {
            console.log('No conversation-names.json found, will use extracted titles');
        }
        
        // Scan ALL conversations with content reading
        const newCache = {
            lastScanTimestamp: new Date().toISOString(),
            knownIds: [],
            conversations: {}
        };
        
        // Track all UUIDs across all conversations for parentUuid mapping
        const allMessageUuids = {}; // uuid -> conversationId mapping
        const conversationMessages = {}; // conversationId -> array of messages
        
        let processedCount = 0;
        const totalCount = allFiles.length;
        
        // First pass: Read all conversations and build UUID index
        for (const fileInfo of allFiles) {
            const filePath = typeof fileInfo === 'string' ? fileInfo : fileInfo.path;
            const convId = path.basename(filePath, '.jsonl');
            
            processedCount++;
            if (processedCount % 10 === 0) {
                console.log(`Processing ${processedCount}/${totalCount} conversations...`);
            }
            
            // Read full content for metadata extraction
            const convData = await this.scanConversationFile(fileInfo, true); // true = read contents
            
            if (convData) {
                // Apply custom name if available
                if (customNames[convId] && customNames[convId].name) {
                    convData.customName = customNames[convId].name;
                }
                
                newCache.conversations[convId] = convData;
                newCache.knownIds.push(convId);
                
                // Now also read messages to build UUID index
                try {
                    const content = await fs.readFile(filePath, 'utf8');
                    const lines = content.trim().split('\n').filter(line => line.trim());
                    const messages = [];
                    
                    for (const line of lines) {
                        try {
                            const msg = JSON.parse(line);
                            messages.push(msg);
                            
                            // Index message UUID to conversation
                            if (msg.uuid) {
                                allMessageUuids[msg.uuid] = convId;
                            }
                        } catch (e) {
                            // Skip malformed JSON
                        }
                    }
                    
                    conversationMessages[convId] = messages;
                } catch (e) {
                    console.error(`Error reading messages from ${filePath}:`, e);
                }
            }
        }
        
        // Second pass: Find parent-child relationships via parentUuid
        console.log('\nAnalyzing parent-child relationships via parentUuid...');
        let parentRelationshipsFound = 0;
        
        for (const convId in conversationMessages) {
            const messages = conversationMessages[convId];
            
            // Check each message's parentUuid
            for (const msg of messages) {
                if (msg.parentUuid && typeof msg.parentUuid === 'string') {
                    // Check if this parentUuid belongs to a different conversation
                    const parentConvId = allMessageUuids[msg.parentUuid];
                    
                    if (parentConvId && parentConvId !== convId) {
                        // This message references a parent in a different conversation!
                        // This means convId is a child of parentConvId
                        if (!newCache.conversations[convId].parentId) {
                            newCache.conversations[convId].parentId = parentConvId;
                            parentRelationshipsFound++;
                            console.log(`Found parent for ${convId}: ${parentConvId} (via parentUuid ${msg.parentUuid})`);
                            break; // Found parent, no need to check more messages
                        }
                    }
                }
            }
        }
        
        console.log(`Found ${parentRelationshipsFound} parent-child relationships via parentUuid`);
        
        // Also check leafUuid relationships as before (as a fallback)
        const leafUuidToConvId = {};
        for (const id in newCache.conversations) {
            const conv = newCache.conversations[id];
            if (conv.leafUuid) {
                leafUuidToConvId[conv.leafUuid] = id;
            }
        }
        
        // Map parent relationships using leafUuid (only if not already found via parentUuid)
        let leafUuidRelationships = 0;
        for (const id in newCache.conversations) {
            const conv = newCache.conversations[id];
            
            // Only use leafUuid if we haven't already found a parent via parentUuid
            if (!conv.parentId && conv.parentLeafUuid && leafUuidToConvId[conv.parentLeafUuid]) {
                const parentId = leafUuidToConvId[conv.parentLeafUuid];
                if (parentId !== id) {  // Avoid self-reference
                    conv.parentId = parentId;
                    leafUuidRelationships++;
                    console.log(`Found parent for ${id}: ${conv.parentId} (via leafUuid ${conv.parentLeafUuid})`);
                }
            }
        }
        
        console.log(`Found ${leafUuidRelationships} additional relationships via leafUuid`);
        
        // Rebuild parent-child relationships
        for (const id in newCache.conversations) {
            newCache.conversations[id].children = [];
        }
        
        for (const id in newCache.conversations) {
            const conv = newCache.conversations[id];
            if (conv.parentId && newCache.conversations[conv.parentId]) {
                newCache.conversations[conv.parentId].children.push(id);
            }
        }
        
        // Log summary of parent-child structure
        let rootCount = 0;
        let childCount = 0;
        for (const id in newCache.conversations) {
            const conv = newCache.conversations[id];
            if (!conv.parentId) {
                rootCount++;
            } else {
                childCount++;
            }
        }
        
        console.log(`\nConversation structure summary:`);
        console.log(`  Root conversations: ${rootCount}`);
        console.log(`  Child conversations: ${childCount}`);
        console.log(`  Total parent relationships: ${parentRelationshipsFound + leafUuidRelationships}`);
        
        // Save updated cache
        await this.saveCache(newCache);
        
        const elapsed = Date.now() - startTime;
        console.log(`Full scan complete in ${elapsed}ms`);
        console.log(`Processed ${Object.keys(newCache.conversations).length} conversations`);
        
        return {
            cache: newCache,
            totalCount: Object.keys(newCache.conversations).length,
            elapsed: elapsed
        };
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