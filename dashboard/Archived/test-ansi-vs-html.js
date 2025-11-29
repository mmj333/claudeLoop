#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

console.log('=== ANSI vs HTML Comparison ===\n');

// Read some actual log lines
const logFile = path.join(__dirname, '../../claudeLogs/claude_2025-07-08_current.txt');
let logLines = [];
try {
  const logContent = fs.readFileSync(logFile, 'utf8');
  logLines = logContent.split('\n').slice(-20); // Last 20 lines
} catch (e) {
  console.log('Could not read log file, using test data');
  logLines = [
    '\x1b[36m● Bash(./restart.sh)\x1b[0m',
    '\x1b[32m✅ Dashboard restarted successfully!\x1b[0m',
    'Normal text \x1b[31m[ERROR]\x1b[0m More normal text',
    '\x1b[33m⚠️  Warning:\x1b[0m Settings not saved',
    '\x1b[32mGreen\x1b[31mRed\x1b[0mNormal',
  ];
}

// Simulate the dashboard's ANSI processing
function simulateDashboardProcessing(line) {
  let processed = line;
  
  // First escape HTML
  processed = processed
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;')
    .split("'").join('&#x27;');
  
  // The dashboard uses \\x1b in the template literal, not \x1b
  // So we need to check what actually arrives in the browser
  const ansiMap = [
    [/\x1b\[31m/g, '<span style="color: #cc0000;">'], // Red
    [/\x1b\[32m/g, '<span style="color: #4e9a06;">'], // Green
    [/\x1b\[33m/g, '<span style="color: #c4a000;">'], // Yellow
    [/\x1b\[36m/g, '<span style="color: #06989a;">'], // Cyan
    [/\x1b\[1m/g, '<span style="font-weight: bold;">'], // Bold
    [/\x1b\[0m/g, '</span>'], // Reset
    [/\x1b\[m/g, '</span>'], // Reset alt
  ];
  
  ansiMap.forEach(([regex, replacement]) => {
    processed = processed.replace(regex, replacement);
  });
  
  // Clean up remaining ANSI codes
  processed = processed.replace(/\x1b\[[0-9;]*m/g, '');
  
  // Span balancing
  const openSpans = (processed.match(/<span/g) || []).length;
  const closeSpans = (processed.match(/<\/span>/g) || []).length;
  
  if (openSpans > closeSpans) {
    const missing = openSpans - closeSpans;
    for (let i = 0; i < missing; i++) {
      processed += '</span>';
    }
  }
  
  return processed;
}

// Test each line
console.log('Comparing log lines with HTML output:\n');

logLines.filter(line => line.trim()).forEach((line, i) => {
  const hasAnsi = line.includes('\x1b[');
  if (hasAnsi) {
    console.log(`Line ${i + 1}:`);
    console.log('ANSI:  ', line.replace(/\x1b/g, '\\x1b'));
    
    const html = simulateDashboardProcessing(line);
    console.log('HTML:  ', html);
    
    // Check for issues
    const issues = [];
    
    // Check if all ANSI codes were processed
    if (html.includes('\\x1b')) {
      issues.push('Unprocessed ANSI codes remain');
    }
    
    // Check span balance
    const openCount = (html.match(/<span/g) || []).length;
    const closeCount = (html.match(/<\/span>/g) || []).length;
    if (openCount !== closeCount) {
      issues.push(`Unbalanced spans: ${openCount} open, ${closeCount} close`);
    }
    
    // Check for nested color spans (the main issue)
    if (html.includes('><span') && line.includes('\x1b[0m')) {
      const colorChanges = (line.match(/\x1b\[\d+m/g) || []).filter(c => c !== '\x1b[0m').length;
      if (colorChanges > 1) {
        issues.push('Nested spans for color changes');
      }
    }
    
    if (issues.length > 0) {
      console.log('Issues:', issues.join(', '));
    } else {
      console.log('✓ OK');
    }
    
    console.log('');
  }
});

// Test specific problem cases
console.log('\n=== Problem Cases ===\n');

const problemCases = [
  {
    name: 'Color change creates nesting',
    input: '\x1b[32mGreen\x1b[31mRed\x1b[0m',
    issue: 'Second color should close first span'
  },
  {
    name: 'Missing reset creates bleed',
    input: '\x1b[36mCyan text',
    issue: 'No closing span, color bleeds to next line'
  },
  {
    name: 'Multiple resets',
    input: '\x1b[32mGreen\x1b[0m Normal \x1b[31mRed\x1b[0m',
    issue: 'Should work correctly'
  }
];

problemCases.forEach(test => {
  console.log(`${test.name}:`);
  console.log('Input: ', test.input.replace(/\x1b/g, '\\x1b'));
  const result = simulateDashboardProcessing(test.input);
  console.log('Output:', result);
  console.log('Issue: ', test.issue);
  console.log('');
});

// Show what's happening in the template literal
console.log('\n=== Template Literal Escaping ===\n');
console.log('In the dashboard source, ANSI codes are written as: \\\\x1b[36m');
console.log('In the template literal, they become: \\x1b[36m');
console.log('When checking with .includes(), we look for: \\x1b[36m');
console.log('But the actual bytes in the string are: \x1b[36m');
console.log('\nThis mismatch might be why some codes aren\'t being replaced!');