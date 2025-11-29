#!/usr/bin/env node

const ConversationTreeScanner = require('./dashboard/conversation-tree-scanner');

async function test() {
    const scanner = new ConversationTreeScanner();
    
    // Test various CWD paths
    const testCases = [
        { cwd: '/home/michael/Computers_Plus_Repair', projectFolder: '-home-michael-Computers-Plus-Repair' },
        { cwd: '/home/michael/Computers_Plus_Repair/src/components', projectFolder: '-home-michael-Computers-Plus-Repair' },
        { cwd: '/home/michael/InfiniQuest/supporter/site', projectFolder: '-home-michael-InfiniQuest-supporter-site' },
        { cwd: '/home/michael/InfiniQuest/backend/routes', projectFolder: '-home-michael-InfiniQuest' },
        { cwd: '/home/michael/InfiniQuest', projectFolder: '-home-michael-InfiniQuest' },
    ];
    
    console.log('Testing getProjectRoot function:\n');
    for (const test of testCases) {
        const result = scanner.getProjectRoot(test.projectFolder, test.cwd);
        console.log(`CWD: ${test.cwd}`);
        console.log(`Folder: ${test.projectFolder}`);
        console.log(`Result: ${result}`);
        console.log(`Expected: ${test.cwd.includes('/backend') || test.cwd.includes('/src') ? test.cwd.split('/').slice(0, test.cwd.split('/').indexOf('backend') || test.cwd.split('/').indexOf('src')).join('/') : test.cwd}`);
        console.log('---');
    }
}

test().catch(console.error);