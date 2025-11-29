#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const readline = require('readline');
const { createReadStream } = require('fs');

class ConversationReader {
    constructor() {
        this.projectsDir = path.join(require('os').homedir(), '.claude', 'projects');
    }

    /**
     * Read messages from a conversation file
     * @param {string} conversationId - The conversation ID
     * @param {number} limit - Maximum number of messages to return (0 = all)
     * @param {number} offset - Number of messages to skip from the beginning
     * @returns {Promise<Array>} Array of message objects
     */
    async readConversation(conversationId, limit = 0, offset = 0) {
        try {
            // Find the conversation file
            const filePath = await this.findConversationFile(conversationId);
            if (!filePath) {
                throw new Error(`Conversation ${conversationId} not found`);
            }

            const messages = [];
            const fileStream = createReadStream(filePath);
            const rl = readline.createInterface({
                input: fileStream,
                crlfDelay: Infinity
            });

            let lineCount = 0;
            let skipped = 0;

            for await (const line of rl) {
                if (!line.trim()) continue;
                
                try {
                    const data = JSON.parse(line);
                    
                    // Skip offset messages
                    if (skipped < offset) {
                        skipped++;
                        continue;
                    }
                    
                    // Process different message types
                    const message = this.processMessage(data, lineCount);
                    if (message) {
                        messages.push(message);
                        lineCount++;
                        
                        // Stop if we've reached the limit
                        if (limit > 0 && messages.length >= limit) {
                            rl.close();
                            break;
                        }
                    }
                } catch (e) {
                    console.error('Error parsing line:', e);
                }
            }

            fileStream.destroy();
            return messages;
        } catch (error) {
            console.error('Error reading conversation:', error);
            return [];
        }
    }

    /**
     * Get the latest N messages from a conversation
     * @param {string} conversationId - The conversation ID
     * @param {number} count - Number of messages to return
     * @returns {Promise<Array>} Array of message objects
     */
    async getLatestMessages(conversationId, count = 50) {
        const allMessages = await this.readConversation(conversationId, 0, 0);
        return allMessages.slice(-count);
    }

    /**
     * Stream new messages as they arrive
     * @param {string} conversationId - The conversation ID
     * @param {function} onMessage - Callback for new messages
     * @param {number} pollInterval - How often to check for new messages (ms)
     * @returns {function} Stop function to end streaming
     */
    streamConversation(conversationId, onMessage, pollInterval = 1000) {
        let lastMessageCount = 0;
        let intervalId;

        const checkForNewMessages = async () => {
            try {
                const messages = await this.readConversation(conversationId, 0, 0);
                if (messages.length > lastMessageCount) {
                    const newMessages = messages.slice(lastMessageCount);
                    newMessages.forEach(msg => onMessage(msg));
                    lastMessageCount = messages.length;
                }
            } catch (error) {
                console.error('Error streaming conversation:', error);
            }
        };

        // Initial check
        checkForNewMessages();

        // Set up polling
        intervalId = setInterval(checkForNewMessages, pollInterval);

        // Return stop function
        return () => {
            if (intervalId) {
                clearInterval(intervalId);
            }
        };
    }

    /**
     * Recursively extract text content from any object structure
     * @param {any} obj - Object to extract text from
     * @param {number} depth - Current recursion depth
     * @returns {string} Extracted text
     */
    extractTextRecursive(obj, depth = 0) {
        if (depth > 5) return ''; // Prevent infinite recursion
        
        // Direct string
        if (typeof obj === 'string') return obj;
        
        // Null/undefined
        if (!obj) return '';
        
        // Array of items
        if (Array.isArray(obj)) {
            return obj.map(item => this.extractTextRecursive(item, depth + 1))
                     .filter(text => text)
                     .join('\n');
        }
        
        // Object with known text fields
        if (typeof obj === 'object') {
            // Check common text field names
            const textFields = ['text', 'content', 'message', 'value', 'body', 'data'];
            for (const field of textFields) {
                if (obj[field]) {
                    const extracted = this.extractTextRecursive(obj[field], depth + 1);
                    if (extracted) return extracted;
                }
            }
            
            // Special handling for tool use
            if (obj.type === 'tool_use' && obj.name) {
                const input = obj.input ? JSON.stringify(obj.input).substring(0, 100) : '';
                return `🔧 ${obj.name}: ${input}`;
            }
            
            // Special handling for tool results
            if (obj.type === 'tool_result' && obj.output) {
                return `📤 Tool Result: ${this.extractTextRecursive(obj.output, depth + 1)}`.substring(0, 200);
            }
        }
        
        return '';
    }

    /**
     * Process a raw message from the JSONL file
     * @param {Object} data - Raw message data
     * @param {number} index - Message index
     * @returns {Object|null} Processed message or null if should skip
     */
    processMessage(data, index) {
        // Extract actual message content from nested structure
        let messageText = '';
        let type = data.type;
        
        // Handle summary messages first - they have a different structure
        if (data.type === 'summary' && data.summary) {
            return {
                id: data.leafUuid || data.uuid || `summary-${index}`,
                type: 'system',
                content: `📝 ${data.summary}`,
                timestamp: data.timestamp || new Date().toISOString(),
                metadata: data
            };
        }
        
        // Handle Claude conversation format where message is nested
        if (data.message && typeof data.message === 'object') {
            // Use the role from message if available, otherwise keep original type
            if (data.message.role) {
                type = data.message.role;
            }
            
            // Handle content array format
            if (data.message.content && Array.isArray(data.message.content)) {
                // Extract text from content array
                messageText = data.message.content
                    .filter(item => item.type === 'text' || item.type === 'tool_result')
                    .map(item => item.text || item.content || '')
                    .join('\n');
            }
            // Handle string content directly
            else if (typeof data.message.content === 'string') {
                messageText = data.message.content;
            }
            
            // Don't return yet - continue processing to check for other formats
        }
        
        if (data.type === 'user' || data.type === 'assistant') {
            // Handle Claude API format with nested content
            if (data.content && typeof data.content === 'object') {
                // Check if content is actually a full message object (from Claude API)
                if (data.content.type === 'message' && data.content.content && Array.isArray(data.content.content)) {
                    // This is a full Claude API message object in the content field
                    messageText = data.content.content
                        .filter(item => item.type === 'text' || item.type === 'tool_result')
                        .map(item => item.text || item.content || '')
                        .join('\n');
                    
                    // If no text content, try to describe tool use
                    if (!messageText && data.content.content.some(item => item.type === 'tool_use')) {
                        const tools = data.content.content.filter(item => item.type === 'tool_use');
                        messageText = tools.map(tool => `🔧 ${tool.name}: ${JSON.stringify(tool.input || {}).substring(0, 100)}`).join('\n');
                    }
                    
                } else if (data.content.content && Array.isArray(data.content.content)) {
                    // Extract text from content array
                    messageText = data.content.content
                        .filter(item => item.type === 'text' || item.type === 'tool_result')
                        .map(item => item.text || item.content || '')
                        .join('\n');
                } else if (data.content.message) {
                    messageText = data.content.message;
                }
            } else if (data.message) {
                messageText = data.message;
            } else if (typeof data.content === 'string') {
                messageText = data.content;
            }
            
            // Special handling for objects that weren't extracted yet
            if (!messageText && data.content && typeof data.content === 'object') {
                // Try to extract any text-like content from the object
                if (data.content.text) {
                    messageText = data.content.text;
                } else if (data.content.role && !data.content.content) {
                    // Empty assistant message, skip it
                    return null;
                }
            }
            
            if (!messageText && data.content && data.content.role) {
                // Skip empty assistant setup messages
                return null;
            }
            
            // Only return if we have actual message text
            if (messageText) {
                return {
                    id: data.uuid || data.id || data.message?.id || `msg-${index}`,
                    type: type, // Use the extracted type (from role if nested)
                    content: messageText,
                    timestamp: data.timestamp || new Date().toISOString(),
                    metadata: {
                        cwd: data.cwd,
                        parentUuid: data.parentUuid,
                        isSidechain: data.isSidechain,
                        isCompactSummary: data.isCompactSummary
                    }
                };
            }
        }
        
        // Handle system messages
        if (data.type === 'system' || data.type === 'compact' || data.type === 'summary') {
            return {
                id: data.uuid || `sys-${index}`,
                type: 'system',
                content: data.message || data.content || '',
                timestamp: data.timestamp || new Date().toISOString(),
                metadata: data
            };
        }

        // Handle tool use messages
        if (data.tool_use || data.tools) {
            return {
                id: `tool-${index}`,
                type: 'tool',
                content: this.formatToolUse(data),
                timestamp: data.timestamp || new Date().toISOString(),
                metadata: data
            };
        }

        // Skip other message types for now
        return null;
    }

    /**
     * Format tool use messages for display
     * @param {Object} data - Tool use data
     * @returns {string} Formatted tool use message
     */
    formatToolUse(data) {
        if (data.tool_use) {
            const tool = data.tool_use;
            return `🔧 Tool: ${tool.name}\nInput: ${JSON.stringify(tool.input, null, 2)}`;
        }
        if (data.tools && Array.isArray(data.tools)) {
            return data.tools.map(tool => 
                `🔧 ${tool.type}: ${tool.name || 'Unknown'}`
            ).join('\n');
        }
        return 'Tool use';
    }

    /**
     * Find a conversation file by ID
     * @param {string} conversationId - The conversation ID
     * @returns {Promise<string|null>} File path or null if not found
     */
    async findConversationFile(conversationId) {
        try {
            const projects = await fs.readdir(this.projectsDir);
            
            for (const project of projects) {
                const projectPath = path.join(this.projectsDir, project);
                const stat = await fs.stat(projectPath);
                
                if (stat.isDirectory()) {
                    const filePath = path.join(projectPath, `${conversationId}.jsonl`);
                    try {
                        await fs.access(filePath);
                        return filePath;
                    } catch {
                        // File doesn't exist in this project, continue
                    }
                }
            }
        } catch (error) {
            console.error('Error finding conversation file:', error);
        }
        
        return null;
    }

    /**
     * Get conversation metadata (first few lines)
     * @param {string} conversationId - The conversation ID
     * @returns {Promise<Object>} Conversation metadata
     */
    async getConversationMetadata(conversationId) {
        try {
            const filePath = await this.findConversationFile(conversationId);
            if (!filePath) {
                return null;
            }

            const stats = await fs.stat(filePath);
            const messages = await this.readConversation(conversationId, 5, 0);
            
            // Find first user message for title
            const firstUserMessage = messages.find(m => m.type === 'user');
            
            return {
                id: conversationId,
                filePath: filePath,
                fileSize: stats.size,
                lastModified: stats.mtime,
                messageCount: await this.countMessages(conversationId),
                firstUserMessage: firstUserMessage?.content?.substring(0, 100),
                cwd: messages[0]?.metadata?.cwd
            };
        } catch (error) {
            console.error('Error getting conversation metadata:', error);
            return null;
        }
    }

    /**
     * Count total messages in a conversation
     * @param {string} conversationId - The conversation ID
     * @returns {Promise<number>} Message count
     */
    async countMessages(conversationId) {
        const messages = await this.readConversation(conversationId, 0, 0);
        return messages.length;
    }
}

// Export for use in other modules
module.exports = ConversationReader;

// CLI interface for testing
if (require.main === module) {
    const reader = new ConversationReader();
    const command = process.argv[2];
    const conversationId = process.argv[3];
    
    async function main() {
        switch (command) {
            case 'read':
                if (!conversationId) {
                    console.error('Usage: conversation-reader.js read <conversation-id> [limit]');
                    process.exit(1);
                }
                const limit = parseInt(process.argv[4]) || 0;
                const messages = await reader.readConversation(conversationId, limit);
                console.log(JSON.stringify(messages, null, 2));
                break;
                
            case 'latest':
                if (!conversationId) {
                    console.error('Usage: conversation-reader.js latest <conversation-id> [count]');
                    process.exit(1);
                }
                const count = parseInt(process.argv[4]) || 50;
                const latest = await reader.getLatestMessages(conversationId, count);
                console.log(JSON.stringify(latest, null, 2));
                break;
                
            case 'metadata':
                if (!conversationId) {
                    console.error('Usage: conversation-reader.js metadata <conversation-id>');
                    process.exit(1);
                }
                const metadata = await reader.getConversationMetadata(conversationId);
                console.log(JSON.stringify(metadata, null, 2));
                break;
                
            case 'stream':
                if (!conversationId) {
                    console.error('Usage: conversation-reader.js stream <conversation-id>');
                    process.exit(1);
                }
                console.log('Streaming conversation (Ctrl+C to stop)...');
                const stop = reader.streamConversation(conversationId, (msg) => {
                    console.log('New message:', msg);
                }, 2000);
                
                // Handle graceful shutdown
                process.on('SIGINT', () => {
                    stop();
                    process.exit(0);
                });
                break;
                
            default:
                console.log('Usage: conversation-reader.js [read|latest|metadata|stream] <conversation-id> [options]');
                console.log('  read      - Read all or limited messages');
                console.log('  latest    - Get latest N messages');
                console.log('  metadata  - Get conversation metadata');
                console.log('  stream    - Stream new messages as they arrive');
        }
    }
    
    main().catch(console.error);
}