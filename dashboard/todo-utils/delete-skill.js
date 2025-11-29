#!/usr/bin/env node

/**
 * Delete Skill Tool - Removes a skill from the database
 * Usage: delete-skill <skill-id>
 * Or: delete-skill <skill-name>
 */

const http = require('http');

// Parse arguments
const input = process.argv.slice(2).join(' ');

if (!input) {
  console.error('Usage: delete-skill <skill-id>');
  console.error('   Or: delete-skill <skill-name>');
  console.error('');
  console.error('Example: delete-skill d450de8f-efd0-419a-b0c0-c5d204cebfb6');
  console.error('Example: delete-skill "Password Security"');
  process.exit(1);
}

const BACKEND_HOST = '192.168.1.2';
const BACKEND_PORT = 5000;

// First, try to find the skill (in case user provided name instead of ID)
function findSkill(query) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BACKEND_HOST,
      port: BACKEND_PORT,
      path: '/api/skills',
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        try {
          const response = JSON.parse(responseData);
          const skills = response.data || [];
          
          // Check if input is a UUID (skill ID)
          const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input);
          
          if (isUuid) {
            // Direct ID match
            const skill = skills.find(s => s._id === input);
            resolve(skill);
          } else {
            // Name match (case insensitive)
            const skill = skills.find(s => 
              s.name && s.name.toLowerCase() === input.toLowerCase()
            );
            resolve(skill);
          }
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// Delete the skill
function deleteSkill(skillId) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BACKEND_HOST,
      port: BACKEND_PORT,
      path: `/api/skills/${skillId}`,
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 204) {
          resolve({ success: true, statusCode: res.statusCode });
        } else {
          reject(new Error(`Delete failed with status ${res.statusCode}: ${responseData}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// Main function
async function main() {
  try {
    console.log('🔍 Searching for skill...');
    
    const skill = await findSkill(input);
    
    if (!skill) {
      console.error(`❌ Skill not found: "${input}"`);
      console.log('\n💡 Tips:');
      console.log('  - Check the exact skill name or ID');
      console.log('  - Use quotes for multi-word names: delete-skill "Time Management"');
      process.exit(1);
    }
    
    console.log(`\n📋 Found skill:`);
    console.log(`   Name: ${skill.name}`);
    console.log(`   ID: ${skill._id}`);
    if (skill.description) {
      console.log(`   Description: ${skill.description.substring(0, 80)}...`);
    }
    
    // Confirm deletion
    console.log('\n⚠️  This will permanently delete this skill from the database.');
    console.log('   Press Ctrl+C to cancel, or wait 3 seconds to proceed...\n');
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    console.log('🗑️  Deleting skill...');
    await deleteSkill(skill._id);
    
    console.log('✅ Skill successfully deleted!');
    console.log(`   Deleted: ${skill.name} (${skill._id})`);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();