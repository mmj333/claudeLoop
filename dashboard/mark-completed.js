const fetch = require('node-fetch');

async function markCompleted() {
  // Fetch current todos
  const response = await fetch('http://localhost:3335/api/todos');
  const todos = await response.json();
  
  // Find and mark completed items
  const completedTexts = [
    'organized into folders by project',
    'Default project folders could = 1 per',
    'checkbox to be on the let side',
    're-sort this list'
  ];
  
  const updates = [];
  todos.forEach(todo => {
    const shouldComplete = completedTexts.some(text => 
      todo.text.toLowerCase().includes(text.toLowerCase())
    );
    
    if (shouldComplete && todo.status === 'pending') {
      updates.push({
        ...todo,
        status: 'completed',
        claude_completed_at: new Date().toISOString(),
        user_approved_at: new Date().toISOString()
      });
    }
  });
  
  if (updates.length > 0) {
    const updateResponse = await fetch('http://localhost:3335/api/todos/bulk-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ todos: updates })
    });
    
    if (updateResponse.ok) {
      console.log(`✅ Marked ${updates.length} todos as completed`);
      updates.forEach(t => console.log(`  - ${t.text.substring(0, 60)}...`));
    }
  } else {
    console.log('No todos to mark as completed');
  }
}

markCompleted().catch(console.error);
