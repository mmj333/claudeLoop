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
        this.projectRootCache = {}; // Cache validated project roots during scan
        this.pathCache = {}; // Cache parsed folder name → filesystem path mappings
    }

    /**
     * Parse project folder name to filesystem path by checking what actually exists
     * Uses incremental path building to handle mixed delimiters correctly
     * @param {string} projectFolder - The Claude project folder name (e.g., "-home-michael-Projects-Computers-Plus-Repair")
     * @returns {string} The best-guess filesystem path
     */
    /**
     * Search for a folder using fuzzy matching as a last resort
     * @param {string} parentPath - Parent directory to search in
     * @param {string} targetName - Name we're looking for (with delimiters stripped)
     * @returns {string|null} - Best matching folder path or null
     */
    searchForFolder(parentPath, targetName) {
        const fsSync = require('fs');

        try {
            if (!fsSync.existsSync(parentPath)) {
                return null;
            }

            // Get all entries in parent directory
            const entries = fsSync.readdirSync(parentPath, { withFileTypes: true });
            const folders = entries.filter(e => e.isDirectory()).map(e => e.name);

            if (folders.length === 0) {
                return null;
            }

            // Strip all delimiters from target and compare
            const cleanTarget = targetName.replace(/[-\s\/_]/g, '').toLowerCase();

            // Find folders with matching stripped names
            const matches = folders.map(folder => {
                const cleanFolder = folder.replace(/[-\s\/_]/g, '').toLowerCase();
                return {
                    folder,
                    cleanFolder,
                    matches: cleanFolder === cleanTarget
                };
            }).filter(m => m.matches);

            if (matches.length > 0) {
                // Return first match (they all match when stripped)
                return path.join(parentPath, matches[0].folder);
            }

            return null;
        } catch (e) {
            console.error(`[Search] Error searching ${parentPath}:`, e.message);
            return null;
        }
    }

    parseFolderNameToPath(projectFolder) {
        // Check cache first for performance
        if (this.pathCache[projectFolder]) {
            return this.pathCache[projectFolder];
        }

        // Split by dashes, filtering out empty strings (from double-dashes which represent literal dashes)
        const parts = projectFolder.replace(/^-/, '').split('-').filter(p => p.length > 0);
        const fsSync = require('fs');

        // Build path incrementally, checking filesystem at each level
        let currentPath = '';
        for (let i = 0; i < parts.length; i++) {
            if (i === 0) {
                currentPath = '/' + parts[i]; // /home
            } else {
                // Try slash, space, then underscore (in order of likelihood)
                const withSlash = currentPath + '/' + parts[i];
                const withSpace = currentPath + ' ' + parts[i];
                const withUnderscore = currentPath + '_' + parts[i];

                try {
                    // Prefer slash for directories
                    if (fsSync.existsSync(withSlash)) {
                        currentPath = withSlash;
                    } else if (fsSync.existsSync(withSpace)) {
                        currentPath = withSpace;
                    } else if (fsSync.existsSync(withUnderscore)) {
                        currentPath = withUnderscore;
                    } else {
                        // None exist - might be a multi-part filename
                        // Try joining remaining parts with different delimiters
                        let found = false;
                        for (const delim of [' ', '_', '-']) {
                            const remaining = parts.slice(i).join(delim);
                            const fullPath = currentPath + '/' + remaining;
                            if (fsSync.existsSync(fullPath)) {
                                this.pathCache[projectFolder] = fullPath;
                                return fullPath;
                            }
                        }

                        // Last resort: search for folder with matching stripped name
                        const remaining = parts.slice(i).join('');
                        const searchResult = this.searchForFolder(currentPath, remaining);
                        if (searchResult) {
                            this.pathCache[projectFolder] = searchResult;
                            return searchResult;
                        }

                        // Default to slash if nothing works
                        currentPath = withSlash;
                    }
                } catch (e) {
                    // Filesystem error, default to slash
                    currentPath = withSlash;
                }
            }
        }

        // Final check: does the computed path exist?
        // If not, try searching from the last known good path
        if (!fsSync.existsSync(currentPath)) {
            // Find last existing ancestor
            let testPath = currentPath;
            let lastGood = '';
            while (testPath.length > 1) {
                const parent = path.dirname(testPath);
                if (fsSync.existsSync(parent)) {
                    lastGood = parent;
                    const target = testPath.substring(parent.length + 1);
                    const searchResult = this.searchForFolder(parent, target);
                    if (searchResult) {
                        this.pathCache[projectFolder] = searchResult;
                        return searchResult;
                    }
                    break;
                }
                testPath = parent;
            }
        }

        // Cache the result before returning
        this.pathCache[projectFolder] = currentPath;
        return currentPath;
    }

    /**
     * Extract project root from project folder name or CWD
     * @param {string} projectFolder - The Claude project folder name (e.g., "-home-michael-InfiniQuest")
     * @param {string} cwd - The working directory from the conversation
     * @returns {string} The project root path
     */
    getProjectRoot(projectFolder, cwd) {
        // Quick cache lookup - cache on combination of projectFolder + cwd
        // This catches both same-folder conversations AND misplaced files (different cwd)
        const cacheKey = `${projectFolder}::${cwd}`;
        if (this.projectRootCache[cacheKey]) {
            return this.projectRootCache[cacheKey];
        }

        let result;

        // If we have a valid CWD, use it as the primary source and validate against project folder
        if (cwd && cwd !== 'unknown') {
            // If we also have a project folder, cross-validate to find the actual project root
            if (projectFolder) {
                // Strip the leading dash from project folder
                const projectName = projectFolder.replace(/^-/, '');

                // Remove all delimiters (slashes, spaces, dashes, underscores) from both for comparison
                const cleanProject = projectName.replace(/[-\s\/_]/g, '').toLowerCase();
                const cleanCwd = cwd.replace(/[-\s\/_]/g, '').toLowerCase();

                // Find where cleanCwd starts to diverge from cleanProject
                let matchLength = 0;
                for (let i = 0; i < Math.min(cleanProject.length, cleanCwd.length); i++) {
                    if (cleanProject[i] === cleanCwd[i]) {
                        matchLength++;
                    } else {
                        break;
                    }
                }

                // If the project folder name matches fully, the CWD might be a subfolder
                // Calculate how many characters we need to trim from the end of CWD
                if (matchLength === cleanProject.length) {
                    const extraChars = cleanCwd.substring(matchLength);

                    // If there are extra characters, we need to trim them from the original CWD
                    if (extraChars.length > 0) {
                        // Count backwards from the end of cwd to remove those characters
                        // (accounting for slashes/spaces/dashes that were stripped)
                        let charsToRemove = 0;
                        let extraCharCount = 0;

                        for (let i = cwd.length - 1; i >= 0 && extraCharCount < extraChars.length; i--) {
                            const char = cwd[i].toLowerCase();
                            if (char !== '/' && char !== ' ' && char !== '-' && char !== '_') {
                                extraCharCount++;
                            }
                            charsToRemove++;
                        }

                        result = cwd.substring(0, cwd.length - charsToRemove).replace(/\/$/, '');
                        this.projectRootCache[cacheKey] = result;
                        return result;
                    }
                }
            }

            // Either no project folder, or cwd matches project folder exactly
            result = cwd.replace(/\/$/, ''); // Normalize trailing slash
            this.projectRootCache[cacheKey] = result;
            return result;
        }

        // Fallback: If no CWD available, try to parse the project folder name
        // This is unreliable due to ambiguous dashes but better than nothing
        if (projectFolder) {
            // Convert the dashed folder name to a path
            // Note: This is a guess - dashes could be path separators OR underscores
            // e.g., "-home-michael-InfiniQuest" -> "/home/michael/InfiniQuest"
            // But "-home-michael-Computers-Plus-Repair" should be "/home/michael/Computers_Plus_Repair"
            // Without the actual CWD, we can't know for sure
            result = projectFolder.replace(/^-/, '/').replace(/-/g, '/').replace(/\/$/, '');
            this.projectRootCache[cacheKey] = result;
            return result;
        }

        result = 'unknown';
        this.projectRootCache[cacheKey] = result;
        return result;
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
            
            // Derive CWD from project folder name or actual conversation content
            let cwd = 'unknown';
            if (projectFolder) {
                // First try to get the real CWD from a conversation file in this folder
                // This is more reliable than parsing the folder name which has ambiguous dashes
                try {
                    // Read just the first few lines to find the CWD
                    const fileContent = await fs.readFile(filePath, 'utf8');
                    const lines = fileContent.split('\n').slice(0, 20); // Check first 20 lines
                    
                    for (const line of lines) {
                        if (line.trim()) {
                            try {
                                const msg = JSON.parse(line);
                                // Look for cwd in various message formats
                                if (msg.cwd) {
                                    cwd = msg.cwd;
                                    break;
                                } else if (msg.message && typeof msg.message === 'object' && msg.message.cwd) {
                                    cwd = msg.message.cwd;
                                    break;
                                } else if (msg.workingDirectory) {
                                    cwd = msg.workingDirectory;
                                    break;
                                }
                            } catch (e) {
                                // Skip malformed JSON lines
                            }
                        }
                    }
                } catch (e) {
                    // If reading fails, fall back to folder name parsing
                }
                
                // If we still don't have a CWD, fall back to parsing the folder name
                if (cwd === 'unknown') {
                    // Use smart parsing to find the actual filesystem path
                    cwd = this.parseFolderNameToPath(projectFolder);
                }
            }

            // Get project root from project folder and CWD
            const projectRoot = this.getProjectRoot(projectFolder, cwd);
            
            const metadata = {
                id: conversationId,
                parentId: null,
                timestamp: stats.birthtime.toISOString(),
                lastModified: stats.mtime.toISOString(),
                fileSize: stats.size,
                cwd: cwd,
                projectRoot: projectRoot,
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
                    
                    // Check if this is a leaf summary file (no sessionIds, all summaries)
                    let hasSessionIds = false;
                    let allSummaries = true;
                    
                    // Track the leafUuid of this conversation (last seen)
                    let conversationLeafUuid = null;
                    let parentLeafUuid = null;
                    let summaryText = null;
                    
                    // Find first user message and parent ID
                    for (let i = 0; i < lines.length; i++) {
                        try {
                            const msg = JSON.parse(lines[i]);

                            // Detect agent/sidechain conversations (can't be resumed)
                            if (msg.isSidechain === true || msg.agentId) {
                                metadata.isSidechain = true;
                            }

                            // Check for sessionIds and summary types for leaf detection
                            if (msg.sessionId) {
                                hasSessionIds = true;
                            }
                            if (msg.type && msg.type !== 'summary') {
                                allSummaries = false;
                            }

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
                    
                    // Mark as leaf summary if it has no sessionIds and all lines are summaries
                    metadata.isLeafSummary = !hasSessionIds && allSummaries && lines.length > 0;
                    
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

        // Find modified conversations (file mtime differs from cached lastModified)
        const modifiedIds = [];
        for (const fileInfo of allFiles) {
            const filePath = typeof fileInfo === 'string' ? fileInfo : fileInfo.path;
            const convId = path.basename(filePath, '.jsonl');

            // Skip new files (they'll be scanned anyway)
            if (newIds.includes(convId)) continue;

            // Check if file has been modified since last scan
            if (cache.conversations[convId]) {
                try {
                    const stats = await fs.stat(filePath);
                    const currentMtime = stats.mtime.toISOString();
                    const cachedMtime = cache.conversations[convId].lastModified;

                    if (cachedMtime && currentMtime !== cachedMtime) {
                        console.log(`Detected modified conversation: ${convId}`);
                        modifiedIds.push(convId);
                    }
                } catch (e) {
                    // File stat failed, skip
                }
            }
        }

        // IDs that need full content scanning (new + modified)
        const idsToScan = [...newIds, ...modifiedIds];

        // Update metadata for conversations NOT being rescanned
        for (const fileInfo of allFiles) {
            const filePath = typeof fileInfo === 'string' ? fileInfo : fileInfo.path;
            const projectFolder = typeof fileInfo === 'object' ? fileInfo.projectFolder : null;
            const convId = path.basename(filePath, '.jsonl');

            // Skip if this will be fully scanned
            if (idsToScan.includes(convId)) continue;

            // Update CWD and projectRoot for existing conversations
            if (projectFolder && cache.conversations[convId]) {
                let cwd = cache.conversations[convId].cwd || 'unknown';

                // Only re-read file if CWD is unknown
                if (cwd === 'unknown') {
                    try {
                        const fileContent = await fs.readFile(filePath, 'utf8');
                        const lines = fileContent.split('\n').slice(0, 20);

                        for (const line of lines) {
                            if (line.trim()) {
                                try {
                                    const msg = JSON.parse(line);
                                    if (msg.cwd) {
                                        cwd = msg.cwd;
                                        break;
                                    } else if (msg.message && typeof msg.message === 'object' && msg.message.cwd) {
                                        cwd = msg.message.cwd;
                                        break;
                                    } else if (msg.workingDirectory) {
                                        cwd = msg.workingDirectory;
                                        break;
                                    }
                                } catch (e) {
                                    // Skip malformed JSON lines
                                }
                            }
                        }
                    } catch (e) {
                        // Fall back to folder name parsing
                    }

                    if (cwd === 'unknown') {
                        cwd = this.parseFolderNameToPath(projectFolder);
                    }
                    cache.conversations[convId].cwd = cwd;
                }

                // Get and set project root
                const projectRoot = this.getProjectRoot(projectFolder, cwd);
                cache.conversations[convId].projectRoot = projectRoot;

                // Update file stats
                try {
                    const stats = await fs.stat(filePath);
                    cache.conversations[convId].fileSize = stats.size;
                    cache.conversations[convId].lastModified = stats.mtime.toISOString();
                } catch (e) {
                    // Stats failed, keep existing values
                }
            }
        }

        // Scan NEW and MODIFIED conversations
        const updates = [];
        for (const scanId of idsToScan) {
            const fileInfo = allFiles.find(f => {
                const filePath = typeof f === 'string' ? f : f.path;
                return path.basename(filePath, '.jsonl') === scanId;
            });
            if (fileInfo) {
                const isModified = modifiedIds.includes(scanId);
                console.log(`Scanning ${isModified ? 'modified' : 'new'} conversation: ${scanId}...`);
                const convData = await this.scanConversationFile(fileInfo);
                
                if (convData) {
                    // Merge with any existing cache data (preserve parent relationship for modified files)
                    if (cache.conversations[scanId]) {
                        convData.parentId = cache.conversations[scanId].parentId || convData.parentId;
                    }
                    updates.push(convData);
                    cache.conversations[scanId] = convData;
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
        console.log(`New: ${newIds.length}, Modified: ${modifiedIds.length}, Deleted: ${deletedIds.length}, Total: ${Object.keys(cache.conversations).length}`);

        return {
            cache: cache,
            newCount: newIds.length,
            modifiedCount: modifiedIds.length,
            updatedCount: newIds.length + modifiedIds.length,  // For backwards compatibility
            deletedCount: deletedIds.length,
            totalCount: Object.keys(cache.conversations).length
        };
    }

    // Force full rescan with file content reading
    async fullScan() {
        console.log('Starting full conversation scan with content extraction...');
        const startTime = Date.now();

        // Clear caches for fresh scan
        this.projectRootCache = {};
        this.pathCache = {};

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
        // Note: We don't store all messages in memory anymore to avoid heap overflow

        // Track file paths so we can re-read them in the second pass
        const conversationFilePaths = {}; // conversationId -> file path

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

                // Store file path for second pass
                conversationFilePaths[convId] = filePath;

                // Read messages to build UUID index (memory-efficient: don't store all messages)
                try {
                    const content = await fs.readFile(filePath, 'utf8');
                    const lines = content.trim().split('\n').filter(line => line.trim());

                    for (const line of lines) {
                        try {
                            const msg = JSON.parse(line);

                            // Index message UUID to conversation
                            if (msg.uuid) {
                                allMessageUuids[msg.uuid] = convId;
                            }

                            // Don't store the full message object - we'll re-read if needed
                        } catch (e) {
                            // Skip malformed JSON
                        }
                    }
                } catch (e) {
                    console.error(`Error reading messages from ${filePath}:`, e);
                }
            }
        }
        
        // Second pass: Find parent-child relationships via parentUuid
        // We re-read files to avoid storing all messages in memory
        console.log('\nAnalyzing parent-child relationships via parentUuid...');
        let parentRelationshipsFound = 0;

        for (const convId in newCache.conversations) {
            const conv = newCache.conversations[convId];

            // Skip if we already found a parent for this conversation
            if (conv.parentId) continue;

            // Get the file path for this conversation
            const convFilePath = conversationFilePaths[convId];
            if (!convFilePath) continue;

            try {
                const content = await fs.readFile(convFilePath, 'utf8');
                const lines = content.trim().split('\n').filter(line => line.trim());

                // Check each message's parentUuid
                for (const line of lines) {
                    try {
                        const msg = JSON.parse(line);

                        if (msg.parentUuid && typeof msg.parentUuid === 'string') {
                            // Check if this parentUuid belongs to a different conversation
                            const parentConvId = allMessageUuids[msg.parentUuid];

                            if (parentConvId && parentConvId !== convId) {
                                // This message references a parent in a different conversation!
                                // This means convId is a child of parentConvId
                                conv.parentId = parentConvId;
                                parentRelationshipsFound++;
                                console.log(`Found parent for ${convId}: ${parentConvId} (via parentUuid ${msg.parentUuid})`);
                                break; // Found parent, no need to check more messages
                            }
                        }
                    } catch (e) {
                        // Skip malformed JSON
                    }
                }
            } catch (e) {
                // File might not exist or be readable - skip
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

        // Create map for quick lookup, excluding agent/sidechain conversations
        for (const id in conversations) {
            const conv = conversations[id];
            // Skip agent conversations (temporary subprocesses that can't be resumed)
            if (conv.isSidechain) {
                continue;
            }
            convMap[id] = { ...conv };
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