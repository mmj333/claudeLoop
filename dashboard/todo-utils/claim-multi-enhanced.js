#!/usr/bin/env node

/**
 * Enhanced Claim-Multi - Claims highest priority todo with duplicate checking
 * Automatically checks for existing skills and provides intelligent options
 */

const http = require('http');
const readline = require('readline');

// Parse arguments
const projects = process.argv.slice(2);

if (projects.length === 0) {
  console.error('Usage: claim-multi-enhanced <project1> <project2> ...');
  console.error('Example: claim-multi-enhanced skills-mental skills-physical skills-professional');
  process.exit(1);
}

// API helpers
function apiRequest(method, endpoint, data = null, port = 3335) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: port,
      path: endpoint,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(responseData));
        } catch (e) {
          resolve(responseData);
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

// Search for related skills
async function searchRelatedSkills(skillName) {
  const options = {
    hostname: '192.168.1.2',
    port: 5000,
    path: '/api/skills?limit=500',
    method: 'GET',
    headers: {
      'Content-Type': 'application/json'
    }
  };

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        try {
          const response = JSON.parse(responseData);
          const skills = response.data || [];
          
          // Extract key terms from skill name for better matching
          const searchTerms = skillName.toLowerCase()
            .replace(/skills?|techniques?|methods?|basics?|fundamentals?|advanced?/gi, '')
            .trim()
            .split(/\s+/);
          
          const related = skills.filter(skill => {
            const nameMatch = searchTerms.some(term => 
              skill.name && skill.name.toLowerCase().includes(term)
            );
            const exactMatch = skill.name && 
              skill.name.toLowerCase() === skillName.toLowerCase();
            
            return nameMatch || exactMatch;
          });
          
          resolve(related);
        } catch (error) {
          resolve([]);
        }
      });
    });

    req.on('error', () => resolve([]));
    req.end();
  });
}

// Main function
async function main() {
  try {
    // Get todos from all specified projects
    console.log(`Scanning ${projects.length} projects for todos...`);
    
    let allTodos = [];
    for (const project of projects) {
      const todos = await apiRequest('GET', `/api/todos`);
      // Filter for pending todos in this project (API doesn't filter properly)
      const projectTodos = todos.filter(todo => 
        todo.project === project && todo.status === 'pending'
      );
      console.log(`  ${project}: ${projectTodos.length} pending todos`);
      projectTodos.forEach(todo => {
        todo.project = project; // Ensure project is set
        allTodos.push(todo);
      });
    }
    
    if (allTodos.length === 0) {
      console.log('\nNo pending todos found in specified projects');
      return;
    }
    
    // Sort by priority (high > normal > low) then by creation date
    const priorityOrder = { high: 3, normal: 2, low: 1 };
    allTodos.sort((a, b) => {
      const priorityDiff = (priorityOrder[b.priority] || 2) - (priorityOrder[a.priority] || 2);
      if (priorityDiff !== 0) return priorityDiff;
      return new Date(a.created_at) - new Date(b.created_at);
    });
    
    // Count by priority
    const highCount = allTodos.filter(t => t.priority === 'high').length;
    const normalCount = allTodos.filter(t => t.priority === 'normal').length;
    const lowCount = allTodos.filter(t => t.priority === 'low').length;
    
    console.log(`\nFound ${allTodos.length} total pending todos:`);
    console.log(`  High priority: ${highCount}`);
    console.log(`  Normal priority: ${normalCount}`);
    console.log(`  Low priority: ${lowCount}`);
    
    // Get the highest priority todo
    const todo = allTodos[0];
    
    // Extract skill name from todo text
    const skillMatch = todo.text.match(/Generate skill template:\s*(.+)/i);
    const skillName = skillMatch ? skillMatch[1].trim() : todo.text;
    
    console.log('\n' + '='.repeat(60));
    console.log('CHECKING FOR RELATED SKILLS');
    console.log('='.repeat(60));
    console.log(`Skill: ${skillName}`);
    
    // Check for related skills
    const relatedSkills = await searchRelatedSkills(skillName);
    
    if (relatedSkills.length > 0) {
      console.log(`\n⚠️  Found ${relatedSkills.length} related skill(s):\n`);
      
      relatedSkills.forEach((skill, index) => {
        console.log(`${index + 1}. ${skill.name}`);
        console.log(`   ID: ${skill._id}`);
        if (skill.description) {
          console.log(`   Description: ${skill.description.substring(0, 80)}...`);
        }
      });
      
      console.log('\n' + '='.repeat(60));
      console.log('RECOMMENDED ACTIONS');
      console.log('='.repeat(60));
      
      // Check for exact match
      const exactMatch = relatedSkills.find(s => 
        s.name.toLowerCase() === skillName.toLowerCase() ||
        s.name.toLowerCase() === skillName.toLowerCase().replace(' skills', '').replace(' techniques', '')
      );
      
      if (exactMatch) {
        console.log('\n🎯 LIKELY DUPLICATE DETECTED!\n');
        console.log('Options:');
        console.log(`1. SKIP - Mark todo as complete (skill already exists)`);
        console.log(`2. SPECIALIZE - Create as specialized version (child skill)`);
        console.log(`3. REPLACE - Delete old and create improved version`);
        console.log(`4. PROCEED - Create anyway (if truly different)\n`);
        
        console.log('💡 Suggested next commands:');
        console.log(`   # To skip (recommended if duplicate):`);
        console.log(`   node todo-client.js complete ${todo.id}\n`);
        
        console.log(`   # To create as child skill:`);
        console.log(`   # Add to your template: "parents": ["${exactMatch._id}"]`);
        console.log(`   # Then proceed with creation\n`);
        
        console.log(`   # To replace with better version:`);
        console.log(`   node /home/michael/InfiniQuest/tmp/claudeLoop/dashboard/todo-utils/delete-skill.js ${exactMatch._id}`);
        console.log(`   # Then proceed with creation\n`);
      } else {
        console.log('\n🤔 POSSIBLY RELATED\n');
        console.log('Consider:');
        console.log('- Is this a specialization? Set one as parent');
        console.log('- Are they complementary? Note in relationships');
        console.log('- Completely different? Proceed normally\n');
        
        if (relatedSkills[0]) {
          console.log(`💡 To set as child of "${relatedSkills[0].name}":`);
          console.log(`   Add to template: "parents": ["${relatedSkills[0]._id}"]`);
        }
      }
      
      console.log('\n' + '='.repeat(60));
      console.log('CLAIMING TODO');
      console.log('='.repeat(60));
    } else {
      console.log('\n✅ No related skills found - safe to create as new skill\n');
      console.log('='.repeat(60));
      console.log('CLAIMING TODO');
      console.log('='.repeat(60));
    }
    
    // Claim the todo regardless (Claude will decide what to do)
    await apiRequest('PUT', `/api/todos/${todo.id}`, {
      ...todo,
      status: 'in_progress'
    });
    
    console.log(`ID: ${todo.id}`);
    console.log(`Priority: ${todo.priority}`);
    console.log(`Project: ${todo.project}`);
    console.log(`Position: ${todo.position || 'not ordered'}\n`);
    console.log(`Task:`);
    console.log(todo.text);
    console.log('='.repeat(60));
    console.log('\nThis task has been claimed and marked as in_progress');
    
    if (relatedSkills.length > 0) {
      console.log('\n📋 DECISION REQUIRED: Review the related skills above and choose your approach');
    }
    
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();