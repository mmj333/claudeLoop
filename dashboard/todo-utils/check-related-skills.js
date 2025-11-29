#!/usr/bin/env node

/**
 * Check Related Skills - Find existing skills that might be related to a new skill
 * Usage: node check-related-skills.js <search-term>
 * 
 * This helps identify potential parent skills or duplicates before creating new ones
 */

const http = require('http');

// Get search term from command line
const searchTerm = process.argv.slice(2).join(' ');

if (!searchTerm) {
  console.error('Usage: node check-related-skills.js <search-term>');
  console.error('Example: node check-related-skills.js negotiation');
  process.exit(1);
}

// Function to search skills
function searchSkills(query) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '192.168.1.2',
      port: 5000,
      path: '/api/skills?limit=500',
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
          
          // Filter skills based on search term
          const searchLower = query.toLowerCase();
          const related = skills.filter(skill => {
            const nameMatch = skill.name && skill.name.toLowerCase().includes(searchLower);
            const descMatch = skill.description && skill.description.toLowerCase().includes(searchLower);
            const tagMatch = skill.tags && skill.tags.some(tag => 
              tag.toLowerCase().includes(searchLower)
            );
            return nameMatch || descMatch || tagMatch;
          });
          
          resolve(related);
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// Main execution
async function main() {
  try {
    console.log(`\n🔍 Searching for skills related to: "${searchTerm}"\n`);
    
    const relatedSkills = await searchSkills(searchTerm);
    
    if (relatedSkills.length === 0) {
      console.log('✅ No related skills found - safe to create as new skill');
      return;
    }
    
    console.log(`Found ${relatedSkills.length} related skill(s):\n`);
    console.log('='.repeat(80));
    
    relatedSkills.forEach((skill, index) => {
      console.log(`\n${index + 1}. ${skill.name}`);
      console.log(`   ID: ${skill._id}`);
      if (skill.description) {
        console.log(`   Description: ${skill.description.substring(0, 100)}...`);
      }
      if (skill.parents && skill.parents.length > 0) {
        console.log(`   Parents: ${skill.parents.join(', ')}`);
      }
      if (skill.tags && skill.tags.length > 0) {
        console.log(`   Tags: ${skill.tags.slice(0, 5).join(', ')}`);
      }
      console.log('   ' + '-'.repeat(76));
    });
    
    console.log('\n' + '='.repeat(80));
    console.log('\n💡 Consider:');
    console.log('   1. Is your new skill a specialization of one above? (set as parent)');
    console.log('   2. Is it a peer/alternative approach? (note in relationships)');
    console.log('   3. Is it actually the same skill? (skip creation)');
    console.log('   4. Is it completely different? (create independently)\n');
    
    // Show example parent setting
    if (relatedSkills.length > 0) {
      const example = relatedSkills[0];
      console.log('📝 To set as child skill in your template:');
      console.log(`   "parents": ["${example._id}"],`);
      console.log(`   "prerequisites": ["${example._id}"],`);
      console.log(`   "prerequisites_raw": ["${example.name.toLowerCase().replace(/ /g, '-')}"],\n`);
    }
    
  } catch (error) {
    console.error('❌ Error searching skills:', error.message);
    process.exit(1);
  }
}

main();