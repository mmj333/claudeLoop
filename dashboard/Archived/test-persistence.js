#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const http = require('http');

const configFile = path.join(__dirname, 'loop-config.json');

async function makeRequest(url, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 3335,
      path: url,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function testPersistence() {
  console.log('=== Testing Settings Persistence ===\n');

  // 1. Read initial config from file
  console.log('1. Reading initial config from file:');
  const initialFileConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  console.log('   delayMinutes:', initialFileConfig.delayMinutes);
  console.log('   useStartTime:', initialFileConfig.useStartTime);
  console.log('   startTime:', initialFileConfig.startTime);

  // 2. Get config from API
  console.log('\n2. Getting config from API:');
  const apiConfig = await makeRequest('/api/config');
  console.log('   delayMinutes:', apiConfig.delayMinutes);
  console.log('   useStartTime:', apiConfig.useStartTime);
  console.log('   startTime:', apiConfig.startTime);

  // 3. Update config via API
  console.log('\n3. Updating config via API:');
  const newConfig = {
    ...apiConfig,
    delayMinutes: 123,
    useStartTime: true,
    startTime: '14:30'
  };
  
  await makeRequest('/api/config', 'PUT', newConfig);
  console.log('   Sent new values: delayMinutes=123, useStartTime=true, startTime=14:30');

  // 4. Wait a bit for save
  console.log('\n4. Waiting 2 seconds for save...');
  await new Promise(resolve => setTimeout(resolve, 2000));

  // 5. Read config from file again
  console.log('\n5. Reading config from file after update:');
  const updatedFileConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  console.log('   delayMinutes:', updatedFileConfig.delayMinutes);
  console.log('   useStartTime:', updatedFileConfig.useStartTime);
  console.log('   startTime:', updatedFileConfig.startTime);

  // 6. Verify persistence
  console.log('\n6. Verification:');
  const fileSuccess = updatedFileConfig.delayMinutes === 123 && 
                     updatedFileConfig.useStartTime === true &&
                     updatedFileConfig.startTime === '14:30';
  console.log('   File update successful:', fileSuccess ? '✅' : '❌');

  // 7. Test if settings persist after simulated page reload
  console.log('\n7. Simulating page reload - getting config from API again:');
  const reloadedConfig = await makeRequest('/api/config');
  console.log('   delayMinutes:', reloadedConfig.delayMinutes);
  console.log('   useStartTime:', reloadedConfig.useStartTime);
  console.log('   startTime:', reloadedConfig.startTime);

  const apiSuccess = reloadedConfig.delayMinutes === 123 && 
                    reloadedConfig.useStartTime === true &&
                    reloadedConfig.startTime === '14:30';
  console.log('   API persistence successful:', apiSuccess ? '✅' : '❌');

  console.log('\n=== Test Complete ===');
  console.log('Overall result:', (fileSuccess && apiSuccess) ? '✅ PASSED' : '❌ FAILED');
}

testPersistence().catch(console.error);