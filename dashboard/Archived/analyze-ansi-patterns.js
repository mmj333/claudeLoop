#!/usr/bin/env node

const http = require('http');

// Get actual logs from the dashboard API
http.get('http://localhost:3335/api/logs', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const logs = JSON.parse(data).logs;
    
    console.log('=== ANSI Patterns in Actual Logs ===\n');
    
    // Find all ANSI escape sequences
    const ansiPattern = /\x1b\[[^m]*m/g;
    const foundPatterns = new Set();
    const examples = {};
    
    // Split into lines and analyze
    const lines = logs.split('\n');
    lines.forEach(line => {
      const matches = line.match(ansiPattern);
      if (matches) {
        matches.forEach(match => {
          foundPatterns.add(match);
          if (!examples[match]) {
            // Store an example of where this pattern is used
            const start = line.indexOf(match);
            const context = line.substring(Math.max(0, start - 10), Math.min(line.length, start + match.length + 20));
            examples[match] = context.replace(/\x1b/g, '\\x1b');
          }
        });
      }
    });
    
    // Sort and display patterns
    const patterns = Array.from(foundPatterns).sort();
    
    console.log(`Found ${patterns.length} unique ANSI patterns:\n`);
    
    // Group by type
    const colorPatterns = patterns.filter(p => p.match(/\[3[0-7]m|\[9[0-7]m/));
    const rgbPatterns = patterns.filter(p => p.includes('[38;2;'));
    const stylePatterns = patterns.filter(p => p.match(/\[[0-9]m/) && !colorPatterns.includes(p));
    const otherPatterns = patterns.filter(p => !colorPatterns.includes(p) && !rgbPatterns.includes(p) && !stylePatterns.includes(p));
    
    console.log('Simple Color Codes (what dashboard handles):');
    colorPatterns.forEach(p => {
      console.log(`  ${p.replace(/\x1b/g, '\\x1b')} - Example: ${examples[p]}`);
    });
    
    console.log('\n24-bit RGB Colors (NOT handled):');
    rgbPatterns.slice(0, 10).forEach(p => {
      console.log(`  ${p.replace(/\x1b/g, '\\x1b')} - Example: ${examples[p]}`);
    });
    if (rgbPatterns.length > 10) {
      console.log(`  ... and ${rgbPatterns.length - 10} more RGB patterns`);
    }
    
    console.log('\nStyle Codes:');
    stylePatterns.forEach(p => {
      console.log(`  ${p.replace(/\x1b/g, '\\x1b')} - Example: ${examples[p]}`);
    });
    
    console.log('\nOther Patterns:');
    otherPatterns.slice(0, 10).forEach(p => {
      console.log(`  ${p.replace(/\x1b/g, '\\x1b')} - Example: ${examples[p]}`);
    });
    
    // Show what needs to be added to handle these
    console.log('\n=== What Dashboard Needs to Handle ===\n');
    console.log('1. 24-bit color codes: \\x1b[38;2;R;G;Bm (foreground)');
    console.log('2. 24-bit color codes: \\x1b[48;2;R;G;Bm (background)');
    console.log('3. Combined codes: \\x1b[1;36m (bold + color)');
    console.log('4. Cursor/screen codes: \\x1b[2K, \\x1b[A, etc.');
    
    // Check for common issues
    console.log('\n=== Common Issues Found ===\n');
    
    let nestedColorCount = 0;
    let unclosedCount = 0;
    
    lines.forEach(line => {
      const colorCodes = (line.match(/\x1b\[(3[0-7]|9[0-7]|38;2;\d+;\d+;\d+)m/g) || []).length;
      const resets = (line.match(/\x1b\[0m/g) || []).length;
      
      if (colorCodes > 1 && resets < colorCodes) {
        nestedColorCount++;
      }
      if (colorCodes > 0 && resets === 0) {
        unclosedCount++;
      }
    });
    
    console.log(`Lines with nested colors: ${nestedColorCount}`);
    console.log(`Lines with unclosed colors: ${unclosedCount}`);
  });
});