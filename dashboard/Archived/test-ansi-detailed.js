#!/usr/bin/env node

// Detailed ANSI vs HTML comparison to understand the differences

console.log('=== Detailed ANSI to HTML Analysis ===\n');

// Test cases that show the problems
const testCases = [
  {
    name: 'Simple color with reset',
    ansi: '\x1b[32mGreen text\x1b[0m',
    expected: '<span style="color: #4e9a06;">Green text</span>',
  },
  {
    name: 'Color change mid-line',
    ansi: '\x1b[32mGreen\x1b[31mRed\x1b[0m',
    expected: '<span style="color: #4e9a06;">Green</span><span style="color: #cc0000;">Red</span>',
  },
  {
    name: 'Unclosed color',
    ansi: '\x1b[36mCyan text without reset',
    expected: '<span style="color: #06989a;">Cyan text without reset</span>',
  },
  {
    name: 'Multiple resets',
    ansi: '\x1b[32mGreen\x1b[0m Normal \x1b[31mRed\x1b[0m',
    expected: '<span style="color: #4e9a06;">Green</span> Normal <span style="color: #cc0000;">Red</span>',
  },
  {
    name: 'Nested styles',
    ansi: '\x1b[1m\x1b[32mBold Green\x1b[0m',
    expected: '<span style="font-weight: bold;"><span style="color: #4e9a06;">Bold Green</span></span>',
  },
  {
    name: 'Real log example',
    ansi: '\x1b[36m● Bash(./restart.sh)\x1b[0m',
    expected: '<span style="color: #06989a;">● Bash(./restart.sh)</span>',
  },
  {
    name: 'Multiple styles same span',
    ansi: '\x1b[1;32mBold and Green\x1b[0m',
    expected: '<span style="font-weight: bold; color: #4e9a06;">Bold and Green</span>',
  }
];

// Current implementation (simplified version)
function currentImplementation(str) {
  let processed = str;
  
  // Escape HTML first
  processed = processed
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;')
    .split("'").join('&#x27;');
  
  // Simple replacements
  const replacements = [
    [/\x1b\[31m/g, '<span style="color: #cc0000;">'],
    [/\x1b\[32m/g, '<span style="color: #4e9a06;">'],
    [/\x1b\[36m/g, '<span style="color: #06989a;">'],
    [/\x1b\[1m/g, '<span style="font-weight: bold;">'],
    [/\x1b\[0m/g, '</span>'],
    [/\x1b\[m/g, '</span>']
  ];
  
  replacements.forEach(([regex, replacement]) => {
    processed = processed.replace(regex, replacement);
  });
  
  return processed;
}

// Analyze each test case
console.log('Current Implementation Results:\n');
testCases.forEach(test => {
  const result = currentImplementation(test.ansi);
  const matches = result === test.expected;
  
  console.log(`Test: ${test.name}`);
  console.log(`Input:    "${test.ansi.replace(/\x1b/g, '\\x1b')}"`);
  console.log(`Expected: "${test.expected}"`);
  console.log(`Got:      "${result}"`);
  console.log(`Match:    ${matches ? '✅' : '❌'}`);
  
  if (!matches) {
    console.log('Issue:    ' + analyzeIssue(test.expected, result));
  }
  console.log('');
});

function analyzeIssue(expected, actual) {
  if (actual.includes('<span') && !actual.includes('</span>')) {
    return 'Missing closing span';
  }
  if (actual.includes('><span') && expected.includes('</span><span')) {
    return 'Nested spans instead of sequential';
  }
  if (actual.split('<span').length !== expected.split('<span').length) {
    return 'Wrong number of spans';
  }
  return 'Other structural difference';
}

// Show what a proper parser would need to handle
console.log('\n=== Key Issues to Address ===\n');
console.log('1. Color changes should close previous span and open new one');
console.log('2. Reset codes (\\x1b[0m) should close ALL open spans');
console.log('3. Unclosed colors need auto-closing at end of line');
console.log('4. Combined codes (\\x1b[1;32m) need to be parsed into multiple styles');
console.log('5. Nested styles need proper span nesting');

// Test the dashboard's current escape pattern
console.log('\n=== Dashboard Escape Pattern Test ===\n');
const dashboardPattern = '\\x1b[36m● Bash(./restart.sh)\\x1b[0m';
console.log('Dashboard stores ANSI as:', dashboardPattern);
console.log('When processed, looking for:', dashboardPattern.replace(/\\/g, '\\\\'));
console.log('But actual ANSI bytes are:', '\x1b[36m● Bash(./restart.sh)\x1b[0m'.replace(/\x1b/g, '\\x1b'));