#!/usr/bin/env node

// Extract and test the HTML generation code
const fs = require('fs');
const path = require('path');

// Read the dashboard file
const dashboardFile = path.join(__dirname, 'claude-loop-unified-dashboard.js');
const content = fs.readFileSync(dashboardFile, 'utf8');

// Find the problematic section
const startMarker = 'onmouseover="this.style.background=';
const startIndex = content.indexOf(startMarker);

if (startIndex === -1) {
  console.log('Could not find the onmouseover code');
  process.exit(1);
}

// Extract a chunk around the problematic area
const chunk = content.substring(startIndex - 200, startIndex + 500);
console.log('Found problematic section:');
console.log('---');
console.log(chunk);
console.log('---');

// Look for syntax issues
const issues = [];

// Check for unescaped quotes
const lines = chunk.split('\n');
lines.forEach((line, i) => {
  // Count quotes
  const singleQuotes = (line.match(/'/g) || []).length;
  const doubleQuotes = (line.match(/"/g) || []).length;
  const escapedSingle = (line.match(/\\'/g) || []).length;
  const escapedDouble = (line.match(/\\"/g) || []).length;
  
  console.log(`Line ${i}: '${singleQuotes}' "${doubleQuotes}" esc:'${escapedSingle}' esc:"${escapedDouble}"`);
  
  if (line.includes('onmouseover') || line.includes('onmouseout')) {
    console.log('Event handler line:', line);
  }
});

// Try to find the exact issue
if (chunk.includes("\\\\'")) {
  console.log('\nFound triple-escaped quotes - this might be the issue');
}

if (chunk.includes("var(--")) {
  console.log('\nFound CSS variables - checking proper escaping...');
  const cssVarRegex = /var\(--[^)]+\)/g;
  const cssVars = chunk.match(cssVarRegex);
  if (cssVars) {
    console.log('CSS variables found:', cssVars);
  }
}