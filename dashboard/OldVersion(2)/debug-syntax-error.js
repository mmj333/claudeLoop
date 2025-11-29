#!/usr/bin/env node

const puppeteer = require('puppeteer');

async function debugSyntaxError() {
  console.log('Launching browser to debug syntax error...');
  
  const browser = await puppeteer.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    const page = await browser.newPage();
    
    // Capture console errors
    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push({
          text: msg.text(),
          location: msg.location()
        });
      }
    });
    
    page.on('pageerror', error => {
      errors.push({
        text: error.message,
        stack: error.stack
      });
    });
    
    console.log('Navigating to dashboard...');
    await page.goto('http://192.168.1.2:3335', { waitUntil: 'domcontentloaded' });
    
    // Wait a bit for any errors to show up
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Get the page content
    const htmlContent = await page.content();
    
    // Save the HTML for inspection
    const fs = require('fs');
    fs.writeFileSync('/tmp/dashboard-rendered.html', htmlContent);
    console.log('Saved rendered HTML to /tmp/dashboard-rendered.html');
    
    // Extract lines around line 2424
    const lines = htmlContent.split('\n');
    console.log(`\nTotal lines in rendered HTML: ${lines.length}`);
    
    // Show lines around 2424
    const targetLine = 2424;
    const context = 10;
    
    console.log(`\nLines around line ${targetLine}:`);
    for (let i = Math.max(0, targetLine - context - 1); i < Math.min(lines.length, targetLine + context); i++) {
      const lineNum = i + 1;
      const marker = lineNum === targetLine ? '>>> ' : '    ';
      console.log(`${marker}${lineNum}: ${lines[i]}`);
    }
    
    // Report any errors captured
    if (errors.length > 0) {
      console.log('\n\nCaptured errors:');
      errors.forEach((err, i) => {
        console.log(`\nError ${i + 1}:`);
        console.log('Text:', err.text);
        if (err.location) {
          console.log('Location:', err.location);
        }
        if (err.stack) {
          console.log('Stack:', err.stack);
        }
      });
    }
    
    // Extract the specific script block that might have issues
    const scriptMatch = htmlContent.match(/<script>[\s\S]*?<\/script>/g);
    if (scriptMatch) {
      console.log(`\n\nFound ${scriptMatch.length} script blocks`);
      
      // Check each script block for syntax
      scriptMatch.forEach((script, i) => {
        try {
          // Remove script tags
          const code = script.replace(/<\/?script>/g, '');
          // Try to parse it
          new Function(code);
        } catch (e) {
          console.log(`\nScript block ${i + 1} has syntax error:`);
          console.log('Error:', e.message);
          
          // Show a portion of the problematic script
          const preview = code.substring(0, 200) + '...';
          console.log('Script preview:', preview);
        }
      });
    }
    
  } catch (error) {
    console.error('Error during debugging:', error);
  } finally {
    await browser.close();
  }
}

debugSyntaxError().catch(console.error);