#!/usr/bin/env node

/**
 * Utility to seed conversation names from Claude's auto-generated titles
 * This reads the first few messages of each conversation to extract titles
 */

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const conversationNamer = require('./conversation-names');
const { readFirstLine } = require('./efficient-line-reader');

async function seedConversationNames(options = {}) {
    const { overwrite = false, limit = 5 } = options;
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    let seeded = 0;
    let skipped = 0;
    let errors = 0;
    
    try {
        // Get all existing names
        const existingNames = await conversationNamer.getAllNames();
        
        // Get all project directories
        const projectDirs = await fs.readdir(projectsDir);
        
        for (const projectDir of projectDirs) {
            if (!projectDir.startsWith('-')) continue;
            
            const fullPath = path.join(projectsDir, projectDir);
            const stats = await fs.stat(fullPath);
            
            if (!stats.isDirectory()) continue;
            
            try {
                // Read conversations from this project
                const files = await fs.readdir(fullPath);
                const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
                
                for (const file of jsonlFiles) {
                    const sessionId = file.replace('.jsonl', '');
                    
                    // Skip if already has a name and not overwriting
                    if (existingNames[sessionId] && !overwrite) {
                        console.log(`⏭️  Skipping ${sessionId} - already has custom name`);
                        skipped++;
                        continue;
                    }
                    
                    const filePath = path.join(fullPath, file);
                    
                    try {
                        // Read the file to extract title
                        const content = await fs.readFile(filePath, 'utf8');
                        const lines = content.trim().split('\n').filter(l => l.trim());
                        
                        let title = null;
                        
                        // Try to get a title from the first user message
                        for (let i = 0; i < Math.min(limit, lines.length); i++) {
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
                        
                        if (title) {
                            await conversationNamer.setName(sessionId, title);
                            console.log(`✅ Seeded ${sessionId}: "${title}"`);
                            seeded++;
                        } else {
                            console.log(`⚠️  No title found for ${sessionId}`);
                        }
                        
                    } catch (err) {
                        console.error(`❌ Error reading ${file}:`, err.message);
                        errors++;
                    }
                }
                
            } catch (err) {
                console.error(`❌ Error reading project ${projectDir}:`, err.message);
                errors++;
            }
        }
        
        console.log('\n📊 Seeding Summary:');
        console.log(`   ✅ Seeded: ${seeded}`);
        console.log(`   ⏭️  Skipped: ${skipped}`);
        console.log(`   ❌ Errors: ${errors}`);
        
    } catch (err) {
        console.error('Fatal error:', err);
        process.exit(1);
    }
}

// CLI interface
if (require.main === module) {
    const args = process.argv.slice(2);
    const overwrite = args.includes('--overwrite');
    
    console.log('🌱 Seeding conversation names from Claude titles...');
    if (overwrite) {
        console.log('⚠️  Overwrite mode: Will replace existing custom names');
    }
    
    seedConversationNames({ overwrite })
        .then(() => process.exit(0))
        .catch(err => {
            console.error('Failed:', err);
            process.exit(1);
        });
}

module.exports = seedConversationNames;