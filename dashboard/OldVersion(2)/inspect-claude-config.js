#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');

const claudeConfigFile = path.join(os.homedir(), '.claude.json');

try {
    const data = fs.readFileSync(claudeConfigFile, 'utf8');
    const config = JSON.parse(data);
    
    console.log('Claude config structure:');
    console.log('Top-level keys:', Object.keys(config));
    
    // Check for conversation-related keys
    const conversationKeys = Object.keys(config).filter(key => 
        key.toLowerCase().includes('conversation') || 
        key.toLowerCase().includes('session') ||
        key.toLowerCase().includes('chat')
    );
    
    if (conversationKeys.length > 0) {
        console.log('\nConversation-related keys:', conversationKeys);
        
        conversationKeys.forEach(key => {
            const value = config[key];
            if (Array.isArray(value)) {
                console.log(`\n${key} (array of ${value.length} items)`);
                if (value.length > 0) {
                    console.log('First item:', JSON.stringify(value[0], null, 2).substring(0, 300) + '...');
                }
            } else if (typeof value === 'object' && value !== null) {
                console.log(`\n${key} (object):`);
                console.log('Keys:', Object.keys(value));
            } else {
                console.log(`\n${key}:`, value);
            }
        });
    }
    
    // Look for any arrays that might contain sessions
    const arrayKeys = Object.keys(config).filter(key => Array.isArray(config[key]));
    console.log('\nArray keys:', arrayKeys);
    
    arrayKeys.forEach(key => {
        const arr = config[key];
        if (arr.length > 0 && typeof arr[0] === 'object' && arr[0].id) {
            console.log(`\n${key} might contain sessions (${arr.length} items)`);
            console.log('First item has keys:', Object.keys(arr[0]));
            if (arr[0].title || arr[0].messages) {
                console.log('Looks like conversations!');
                console.log('Sample:', {
                    id: arr[0].id,
                    title: arr[0].title || 'N/A',
                    hasMessages: !!arr[0].messages
                });
            }
        }
    });
    
} catch (err) {
    console.error('Error reading Claude config:', err.message);
}