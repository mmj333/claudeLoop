#!/usr/bin/env node

/**
 * Quick Todo Reorganizer for Claude
 * Simple script to intelligently reorganize todos
 */

const TodoManager = require('./todo-manager');

async function reorganizeTodos() {
  const manager = new TodoManager();
  
  console.log('🔄 Starting intelligent todo reorganization...\n');
  
  // First analyze current state and show available projects
  console.log('📊 Analyzing current todos...');
  const analysis = await manager.analyzeTodos();
  
  console.log(`Found ${analysis.total} todos`);
  console.log('Status breakdown:', analysis.byStatus);
  console.log('Project breakdown:', analysis.byProject);
  
  if (analysis.availableProjects.length > 0) {
    console.log('\n📁 Available Projects:');
    analysis.availableProjects.forEach(p => {
      const count = analysis.byProject[p.id] || 0;
      console.log(`  • ${p.name}${p.id !== p.name ? ` (${p.id})` : ''}: ${count} todos`);
    });
  }
  
  if (analysis.suggestions.length > 0) {
    console.log('\n💡 Issues found:');
    analysis.suggestions.forEach(s => console.log(`  - ${s}`));
  }
  
  // Perform reorganization (within projects by default)
  console.log('\n🔧 Reorganizing within projects...');
  const result = await manager.reorganize({
    createHierarchy: true,
    sortByPriority: true,
    reorganizeProjects: false  // Don't move between projects by default
  });
  
  console.log('\n✅ Reorganization complete!');
  console.log('\nCreated groups:');
  Object.entries(result.groups).forEach(([group, items]) => {
    console.log(`  ${group}: ${items.length} items`);
  });
  
  console.log('\n📝 A backup was automatically created before reorganization.');
  console.log('If you want to undo, run: node todo-utils/todo-manager.js restore <backup-file>');
  console.log('\n💡 To reorganize across projects, use: node todo-utils/todo-manager.js');
}

// Run if called directly
if (require.main === module) {
  reorganizeTodos().catch(console.error);
}

module.exports = reorganizeTodos;