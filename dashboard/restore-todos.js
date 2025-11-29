const fetch = require('node-fetch');

async function restoreTodos() {
  // The missing todos from earlier
  const missingTodos = [
    {
      text: "The countdown next to \"Next message in:\" doesn't count down smoothly. We could probably fix this without adding much inefficiency I'd assume. :)",
      status: "pending",
      priority: "normal",
      category: "bug",
      project: "claude-loop9"
    },
    {
      text: "Also, I feel like we should make use of these and show the latest ones per loop in the dashboard: /home/michael/.claude/todos",
      status: "pending",
      priority: "normal",
      project: "claude-loop9"
    },
    {
      text: "Also, unless we combine todo utilities (mine and default-claude's) I think we need a way to auto send him ToDo's from this list and give him (or remind him of) tools to add things to the list, and update this list.",
      status: "pending",
      priority: "normal",
      project: "claude-loop9"
    },
    {
      text: "Would be cool to have a way to detect when claude was asking you a question on the screen and... and more quickly send tmux an \"enter\" key. And/or if we could have another AI analyze the message and decide whether or not to hit enter ;)",
      status: "pending",
      priority: "normal",
      project: "claude-loop9"
    },
    {
      text: "shift + tab keyboard shortcut for claude dashboard",
      status: "pending",
      priority: "normal",
      project: "claude-loop9"
    },
    {
      text: "make a utility for claude to query, that will fetching next skill for him to work on.",
      status: "pending",
      priority: "normal",
      project: "claude-loop8"
    },
    {
      text: "Get INFINI working for Cognitive Behavioral Therapy exercises. We need to be able to process our emotions and false beliefs. :)",
      status: "pending",
      priority: "high",
      project: "claude-loop3"
    }
  ];

  // First, remove the "Other Tasks" fake todo
  const currentTodos = await fetch('http://localhost:3335/api/todos').then(r => r.json());
  const otherTasksTodo = currentTodos.find(t => t.text === "Other Tasks");
  
  if (otherTasksTodo) {
    await fetch(`http://localhost:3335/api/todos/${otherTasksTodo.id}`, {
      method: 'DELETE'
    });
    console.log('✅ Removed "Other Tasks" placeholder');
  }

  // Add the missing todos
  for (const todo of missingTodos) {
    const response = await fetch('http://localhost:3335/api/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(todo)
    });
    if (response.ok) {
      console.log(`✅ Added: ${todo.text.substring(0, 50)}...`);
    }
  }

  console.log('\n📊 Restoration complete!');
}

restoreTodos().catch(console.error);
