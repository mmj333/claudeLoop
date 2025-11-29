const fetch = require('node-fetch');

async function cleanupTodos() {
  const response = await fetch('http://localhost:3335/api/todos');
  const todos = await response.json();
  
  // Find todos to delete (test todos and Other Tasks)
  const toDelete = todos.filter(t => 
    t.text === 'Other Tasks' ||
    t.text.includes('Test todo from') ||
    t.text.includes('DELETE_ME') ||
    t.text.includes('E2E_TEST') ||
    t.text.includes('Quick test todo') ||
    t.text.includes('Concurrent test') ||
    t.text.includes('!@#$%^&*')
  );
  
  console.log(`Found ${toDelete.length} test/junk todos to delete`);
  
  for (const todo of toDelete) {
    await fetch(`http://localhost:3335/api/todos/${todo.id}`, { method: 'DELETE' });
    console.log(`  ✅ Deleted: ${todo.text.substring(0, 50)}`);
  }
  
  console.log('\n✅ Cleanup complete!');
}

cleanupTodos().catch(console.error);
