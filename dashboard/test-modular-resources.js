#!/usr/bin/env node

/**
 * Test that modular resources are being served correctly
 */

const http = require('http');

function testResource(path, expectedContent) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '192.168.1.2',
      port: 3335,
      path: path,
      method: 'GET'
    };

    console.log(`Testing ${path}...`);
    
    const req = http.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        console.log(`  Status: ${res.statusCode}`);
        console.log(`  Content-Type: ${res.headers['content-type']}`);
        console.log(`  Length: ${data.length} bytes`);
        
        if (res.statusCode === 200) {
          if (expectedContent && !data.includes(expectedContent)) {
            console.log(`  ❌ Missing expected content: "${expectedContent}"`);
            resolve(false);
          } else {
            console.log(`  ✅ Resource loaded successfully`);
            resolve(true);
          }
        } else {
          console.log(`  ❌ Failed with status ${res.statusCode}`);
          console.log(`  Response: ${data.substring(0, 200)}`);
          resolve(false);
        }
      });
    });
    
    req.on('error', (err) => {
      console.log(`  ❌ Error: ${err.message}`);
      resolve(false);
    });
    
    // Set a timeout
    req.setTimeout(3000, () => {
      console.log(`  ❌ Timeout after 3 seconds`);
      req.destroy();
      resolve(false);
    });
    
    req.end();
  });
}

async function runTests() {
  console.log('Testing Claude Loop Dashboard Modular Resources\n');
  
  const tests = [
    { path: '/', expected: '<title>' },
    { path: '/dashboard-styles.css', expected: '--bg-primary' },
    { path: '/dashboard-utils.js', expected: 'dashboardUtils' },
  ];
  
  let allPassed = true;
  
  for (const test of tests) {
    const passed = await testResource(test.path, test.expected);
    if (!passed) allPassed = false;
    console.log();
  }
  
  if (allPassed) {
    console.log('✅ All tests passed!');
  } else {
    console.log('❌ Some tests failed. Check the routes in the dashboard server.');
  }
}

runTests();