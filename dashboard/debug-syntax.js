#!/usr/bin/env node

const puppeteer = require('puppeteer');

async function debugSyntaxError() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    
    // Capture console errors
    page.on('pageerror', error => {
      console.error('Page error:', error.message);
      console.error('Stack:', error.stack);
    });
    
    page.on('error', error => {
      console.error('Error:', error);
    });
    
    // Capture console messages
    page.on('console', msg => {
      if (msg.type() === 'error') {
        console.error('Console error:', msg.text());
      }
    });
    
    console.log('Loading dashboard...');
    const response = await page.goto('http://192.168.1.2:3335', {
      waitUntil: 'domcontentloaded'
    });
    
    // Get the actual HTML being served
    const html = await response.text();
    
    // Find line 2523
    const lines = html.split('\n');
    console.log('\n=== Line 2523 (and surrounding lines): ===');
    for (let i = 2520; i <= 2525 && i < lines.length; i++) {
      const marker = i === 2523 ? '>>> ' : '    ';
      console.log(`${marker}${i}: ${lines[i-1]}`);
    }
    
    // Try to identify the exact character position 88
    if (lines[2522]) { // Line 2523 is index 2522
      const line = lines[2522];
      console.log('\n=== Character position around 88: ===');
      console.log('Position 80-100:', line.substring(80, 100));
      console.log('Full line:', line);
      
      // Check for common issues
      if (line.includes('" "')) {
        console.log('\nFound potential issue: double quote space double quote pattern');
      }
      if (line.includes("' '")) {
        console.log('\nFound potential issue: single quote space single quote pattern');
      }
    }
    
  } catch (error) {
    console.error('Script error:', error);
  } finally {
    await browser.close();
  }
}

debugSyntaxError();