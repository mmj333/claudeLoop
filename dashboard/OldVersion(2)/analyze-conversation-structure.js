#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const os = require('os');

/**
 * Utility to analyze and map the complete structure of Claude conversation JSONL files
 * This will discover all available fields and patterns in conversation data
 */

class ConversationAnalyzer {
    constructor() {
        this.projectsDir = path.join(os.homedir(), '.claude', 'projects');
        this.fieldStats = {};
        this.messageTypes = new Set();
        this.leafUuidRelationships = [];
        this.allFields = new Set();
        this.exampleMessages = {};
    }

    async analyzeAllConversations() {
        console.log('Starting comprehensive conversation analysis...\n');
        
        const files = await this.getAllConversationFiles();
        console.log(`Found ${files.length} conversation files to analyze\n`);
        
        let totalMessages = 0;
        let conversationsWithParents = 0;
        let conversationsWithChildren = 0;
        
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            console.log(`Analyzing ${i + 1}/${files.length}: ${path.basename(file.path)}`);
            
            const analysis = await this.analyzeConversation(file.path);
            if (analysis) {
                totalMessages += analysis.messageCount;
                if (analysis.hasParent) conversationsWithParents++;
                if (analysis.hasChildren) conversationsWithChildren++;
            }
        }
        
        // Generate report
        this.generateReport(totalMessages, conversationsWithParents, conversationsWithChildren, files.length);
    }

    async analyzeConversation(filePath) {
        try {
            const content = await fs.readFile(filePath, 'utf8');
            const lines = content.trim().split('\n').filter(line => line.trim());
            
            const conversationId = path.basename(filePath, '.jsonl');
            let hasParent = false;
            let hasChildren = false;
            let leafUuids = new Set();
            let parentLeafUuid = null;
            
            for (let i = 0; i < lines.length; i++) {
                try {
                    const msg = JSON.parse(lines[i]);
                    
                    // Track message type
                    if (msg.type) {
                        this.messageTypes.add(msg.type);
                        
                        // Store example of each message type
                        if (!this.exampleMessages[msg.type]) {
                            this.exampleMessages[msg.type] = {
                                example: msg,
                                fields: Object.keys(msg)
                            };
                        }
                    }
                    
                    // Track all fields
                    this.analyzeFields(msg, '');
                    
                    // Track leafUuid patterns
                    if (msg.leafUuid) {
                        leafUuids.add(msg.leafUuid);
                    }
                    
                    // Check for parent indicators
                    if (i === 0 && msg.type === 'summary' && msg.leafUuid) {
                        parentLeafUuid = msg.leafUuid;
                        hasParent = true;
                    }
                    
                    // Check for descendant fields (user mentioned "isdescendant")
                    if (msg.isDescendant || msg.isdescendant || msg.is_descendant) {
                        console.log(`  Found descendant field in ${conversationId}: ${JSON.stringify(msg)}`);
                        hasChildren = true;
                    }
                    
                    // Check for parent fields
                    if (msg.parentUuid || msg.parent_uuid || msg.parentId) {
                        console.log(`  Found parent field in ${conversationId}: parentUuid=${msg.parentUuid}, parent_uuid=${msg.parent_uuid}, parentId=${msg.parentId}`);
                        hasParent = true;
                    }
                    
                    // Check for fork indicators
                    if (msg.isFork || msg.is_fork || msg.forkedFrom) {
                        console.log(`  Found fork indicator in ${conversationId}: ${JSON.stringify({ isFork: msg.isFork, is_fork: msg.is_fork, forkedFrom: msg.forkedFrom })}`);
                        hasChildren = true;
                    }
                    
                } catch (e) {
                    // Skip malformed JSON
                }
            }
            
            return {
                conversationId,
                messageCount: lines.length,
                hasParent,
                hasChildren,
                leafUuids: Array.from(leafUuids),
                parentLeafUuid
            };
            
        } catch (error) {
            console.error(`Error analyzing ${filePath}:`, error);
            return null;
        }
    }
    
    analyzeFields(obj, prefix) {
        for (const key in obj) {
            const fullKey = prefix ? `${prefix}.${key}` : key;
            this.allFields.add(fullKey);
            
            // Track field usage stats
            if (!this.fieldStats[fullKey]) {
                this.fieldStats[fullKey] = {
                    count: 0,
                    types: new Set(),
                    examples: []
                };
            }
            
            this.fieldStats[fullKey].count++;
            this.fieldStats[fullKey].types.add(typeof obj[key]);
            
            // Store a few examples
            if (this.fieldStats[fullKey].examples.length < 3 && obj[key] !== null && obj[key] !== undefined) {
                const example = typeof obj[key] === 'object' ? JSON.stringify(obj[key]).substring(0, 100) : String(obj[key]).substring(0, 100);
                if (!this.fieldStats[fullKey].examples.includes(example)) {
                    this.fieldStats[fullKey].examples.push(example);
                }
            }
            
            // Recurse into objects (but not arrays to avoid noise)
            if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
                this.analyzeFields(obj[key], fullKey);
            }
        }
    }
    
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
    
    generateReport(totalMessages, conversationsWithParents, conversationsWithChildren, totalConversations) {
        console.log('\n===========================================');
        console.log('CONVERSATION STRUCTURE ANALYSIS REPORT');
        console.log('===========================================\n');
        
        console.log('SUMMARY STATISTICS:');
        console.log(`  Total conversations: ${totalConversations}`);
        console.log(`  Total messages: ${totalMessages}`);
        console.log(`  Conversations with parents: ${conversationsWithParents}`);
        console.log(`  Conversations with children: ${conversationsWithChildren}`);
        console.log();
        
        console.log('MESSAGE TYPES FOUND:');
        Array.from(this.messageTypes).sort().forEach(type => {
            console.log(`  - ${type}`);
            if (this.exampleMessages[type]) {
                console.log(`    Fields: ${this.exampleMessages[type].fields.join(', ')}`);
            }
        });
        console.log();
        
        console.log('KEY RELATIONSHIP FIELDS:');
        const relationshipFields = ['leafUuid', 'parentUuid', 'parent_uuid', 'parentId', 
                                   'isDescendant', 'isdescendant', 'is_descendant',
                                   'isFork', 'is_fork', 'forkedFrom'];
        
        relationshipFields.forEach(field => {
            if (this.fieldStats[field]) {
                console.log(`  ${field}:`);
                console.log(`    Count: ${this.fieldStats[field].count}`);
                console.log(`    Types: ${Array.from(this.fieldStats[field].types).join(', ')}`);
                if (this.fieldStats[field].examples.length > 0) {
                    console.log(`    Examples: ${this.fieldStats[field].examples.slice(0, 2).join(', ')}`);
                }
            }
        });
        console.log();
        
        console.log('ALL FIELDS DISCOVERED (Top 50 by frequency):');
        const sortedFields = Object.entries(this.fieldStats)
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 50);
        
        sortedFields.forEach(([field, stats]) => {
            console.log(`  ${field}: ${stats.count} occurrences`);
        });
        
        // Save detailed report to file
        const reportPath = path.join(__dirname, 'conversation-structure-report.json');
        const report = {
            timestamp: new Date().toISOString(),
            summary: {
                totalConversations,
                totalMessages,
                conversationsWithParents,
                conversationsWithChildren
            },
            messageTypes: Array.from(this.messageTypes),
            exampleMessages: this.exampleMessages,
            fieldStats: this.fieldStats,
            allFields: Array.from(this.allFields)
        };
        
        fs.writeFile(reportPath, JSON.stringify(report, null, 2))
            .then(() => console.log(`\nDetailed report saved to: ${reportPath}`))
            .catch(err => console.error('Failed to save report:', err));
    }
}

// Run the analyzer
if (require.main === module) {
    const analyzer = new ConversationAnalyzer();
    analyzer.analyzeAllConversations().catch(console.error);
}

module.exports = ConversationAnalyzer;
