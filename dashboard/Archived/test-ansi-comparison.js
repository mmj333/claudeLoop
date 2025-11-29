#!/usr/bin/env node

// Test ANSI codes vs HTML output
const testStrings = [
  '\x1b[32mGreen text\x1b[0m',
  '\x1b[31mRed text\x1b[0m',
  '\x1b[36mCyan text\x1b[0m',
  '\x1b[1mBold text\x1b[0m',
  '\x1b[32mGreen\x1b[31mRed\x1b[0m',
  '\x1b[32mUnclosed green color',
  'Normal \x1b[33mYellow\x1b[0m Normal'
];

console.log('=== ANSI Code Comparison Test ===\n');

// Show raw ANSI in terminal
console.log('1. Raw ANSI codes (as shown in terminal):');
testStrings.forEach(str => {
  console.log(`   ${str}`);
});

console.log('\n2. ANSI escape sequences visible:');
testStrings.forEach(str => {
  // Make ANSI codes visible
  const visible = str.replace(/\x1b/g, '\\x1b');
  console.log(`   ${visible}`);
});

console.log('\n3. What our converter should produce:');

// Simulate our ANSI to HTML conversion
function convertAnsiToHtml(str) {
  let processed = str;
  
  // First escape HTML
  processed = processed
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;')
    .split("'").join('&#x27;');
  
  // Convert using our map approach
  const ansiMap = [
    ['\x1b[31m', '<span style="color: #cc0000;">'], // Red
    ['\x1b[32m', '<span style="color: #4e9a06;">'], // Green
    ['\x1b[33m', '<span style="color: #c4a000;">'], // Yellow
    ['\x1b[36m', '<span style="color: #06989a;">'], // Cyan
    ['\x1b[1m', '<span style="font-weight: bold;">'], // Bold
    ['\x1b[0m', '</span>'], // Reset
    ['\x1b[m', '</span>']  // Reset alt
  ];
  
  ansiMap.forEach(([ansi, html]) => {
    while (processed.includes(ansi)) {
      processed = processed.replace(ansi, html);
    }
  });
  
  // Clean up remaining codes
  processed = processed.replace(/\x1b\[[0-9;]*m/g, '');
  
  // Count spans for balance check
  const openSpans = (processed.match(/<span/g) || []).length;
  const closeSpans = (processed.match(/<\/span>/g) || []).length;
  
  console.log(`   "${str}" →`);
  console.log(`   "${processed}"`);
  console.log(`   Spans: ${openSpans} open, ${closeSpans} close${openSpans !== closeSpans ? ' ⚠️ UNBALANCED!' : ' ✓'}`);
  
  return processed;
}

testStrings.forEach(convertAnsiToHtml);

console.log('\n4. Testing with actual log line:');
const logLine = '\x1b[36m● Bash(./restart.sh)\x1b[0m';
console.log(`   Input: "${logLine}"`);
const converted = convertAnsiToHtml(logLine);
console.log(`   Output: "${converted}"`);

// Test the span balancing fix
console.log('\n5. Testing span balancing fix:');
function addMissingSpans(html) {
  const openSpans = (html.match(/<span/g) || []).length;
  const closeSpans = (html.match(/<\/span>/g) || []).length;
  
  if (openSpans > closeSpans) {
    const missing = openSpans - closeSpans;
    for (let i = 0; i < missing; i++) {
      html += '</span>';
    }
    console.log(`   Added ${missing} closing span(s)`);
  }
  
  return html;
}

const unbalanced = '<span style="color: #06989a;">Cyan text without close';
console.log(`   Before: "${unbalanced}"`);
console.log(`   After: "${addMissingSpans(unbalanced)}"`);