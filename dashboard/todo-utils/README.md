# Todo Management Utilities

This folder contains utilities for managing the todo list in the Claude Loop Dashboard.

📚 **[See FEATURES.md for complete feature documentation](FEATURES.md)**

## Quick Start for Claude Sessions

### NEW: Efficient Todo Client (No Permissions Required!)
```bash
# Use todo-client.js for all todo operations - no curl permission prompts!
node todo-utils/todo-client.js list                    # List pending todos
node todo-utils/todo-client.js list pending claude-loop9  # For specific project
node todo-utils/todo-client.js claim claude-loop9      # Claim next task from single project
node todo-utils/todo-client.js claim-multi skills-physical skill-seeding skills-academic  # Claim highest priority across multiple projects
node todo-utils/todo-client.js complete <id>           # Mark as done
node todo-utils/todo-client.js search "bug"            # Search todos
node todo-utils/todo-client.js stats                   # Show statistics
node todo-utils/todo-client.js add "todo text" [project] 
etc.
```

### Alternative: Individual Tools
```bash
# Set your session (e.g., claude-loop9)
export CLAUDE_SESSION=claude-loop9

# Option 1: Claim next task (adds to your native todos)
node todo-utils/claim-next.js

# Option 2: Just check what's next without claiming
node todo-utils/get-next.js
```

### Getting Tasks Efficiently
```bash
# Get pending todos for your project only (compact format)
curl 'http://localhost:3335/api/todos/pending?project=claude-loop9&format=compact'

# Search for specific work
curl 'http://localhost:3335/api/todos/search?q=bug&status=pending&format=compact'

# Get all todos for your project
curl 'http://localhost:3335/api/todos/project/claude-loop9'
```

### Key Benefits
- **claim-next.js** - Bridges dashboard todos with your native todo list
- **format=compact** - 43% smaller responses, faster parsing
- **project filtering** - Only see relevant work for your session

## Available Tools

### 1. Todo Manager (`todo-manager.js`)
Main utility for comprehensive todo management.

**Interactive Mode:**
```bash
node todo-utils/todo-manager.js
```

**Command Line:**
```bash
# Backup current todos
node todo-utils/todo-manager.js backup [label]

# List available backups
node todo-utils/todo-manager.js list-backups

# Restore from backup
node todo-utils/todo-manager.js restore <backup-file>

# Analyze todo structure
node todo-utils/todo-manager.js analyze

# Reorganize todos
node todo-utils/todo-manager.js reorganize --hierarchy --sort
```

### 2. Quick Reorganizer (`reorganize-todos.js`)
One-command intelligent reorganization.

```bash
# Automatically analyzes and reorganizes todos
node todo-utils/reorganize-todos.js
```

This will:
- Group related todos by keywords
- Create logical hierarchy
- Sort by priority
- Automatically backup before changes

### 3. Get Next Todo (`get-next.js`)
Quick command to get the highest priority pending todo.

```bash
# Get next todo from all projects
node todo-utils/get-next.js

# Get next todo from specific project
node todo-utils/get-next.js claude-loop9

# Use with environment variable
CLAUDE_SESSION=claude-loop9 node todo-utils/get-next.js
```

Returns: ID, priority, project, and task text.

### 4. Claim Next Todo (`claim-next.js`)
Claims a todo from dashboard and adds to Claude's native todos.

```bash
# Claim next todo (any project)
node todo-utils/claim-next.js [conversationId]

# Claim from specific project
node todo-utils/claim-next.js [conversationId] claude-loop9

# Use with environment variables
CLAUDE_CONVERSATION_ID=abc CLAUDE_SESSION=claude-loop9 node todo-utils/claim-next.js
```

This will:
- Get highest priority pending todo
- Mark it as `in_progress` in dashboard
- Add to Claude's native todo file
- Link both systems with `dashboardId`

### 5. Export Utility (`export-todos.js`)
Export todos in various formats.

```bash
# Export as Markdown
node todo-utils/export-todos.js markdown todos.md

# Export as CSV
node todo-utils/export-todos.js csv todos.csv

# Export as plain text
node todo-utils/export-todos.js text todos.txt

# Export summary for Claude
node todo-utils/export-todos.js claude summary.md
```

### 6. Bulk Import Skills (`import-skills.js`)
Import hundreds of skills or tasks from text files for Claude to work through.

```bash
# Import from text file (one skill per line)
node todo-utils/import-skills.js skills.txt [project-name]

# Import with specific project name (default: skill-seeding)
node todo-utils/import-skills.js skills.txt skill-seeding

# Supported formats: .txt, .json, .csv
```

**Important:** Project name defaults to 'skill-seeding' but can be customized. The import:
- Creates todos in the specified project folder/group
- Prevents duplicate imports (checks existing todos)
- Imports in batches of 10 for safety
- Shows statistics after import

Perfect for:
- Seeding InfiniQuest skills database
- Batch processing tasks
- Creating work queues for Claude

### 7. Todo Client (`todo-client.js`)
Efficient CLI for all todo operations without curl permission prompts.

```bash
# List todos
node todo-utils/todo-client.js list [status] [project]

# Add a new todo
node todo-utils/todo-client.js add "todo text" [project]
node todo-utils/todo-client.js add "High priority task" -p claude-loop9 --priority high

# Search todos
node todo-utils/todo-client.js search "query"

# Update todo fields
node todo-utils/todo-client.js update <id> <field> <value>

# Claim next todo from single project
node todo-utils/todo-client.js claim [project]

# NEW: Claim highest priority todo across multiple projects
node todo-utils/todo-client.js claim-multi <project1> <project2> ...
# Example: node todo-utils/todo-client.js claim-multi skills-physical skill-seeding skills-academic
# This will:
#   - Scan all specified projects for pending todos
#   - Select the highest priority todo (HIGH > NORMAL > LOW)
#   - Respect the order field (position in todo list) within each priority level
#   - Mark the selected todo as in_progress

# Complete todo
node todo-utils/todo-client.js complete <id>

# Show statistics
node todo-utils/todo-client.js stats [project]

# List all projects
node todo-utils/todo-client.js projects
```

**Note:** For bulk adding many todos (e.g., 100s of skills), use `import-skills.js` instead.

## Features

### Automatic Backups
- All reorganization operations automatically create backups
- Backups are stored in `todo-utils/backups/`
- Timestamped filenames for easy tracking

### Smart Grouping
The reorganizer identifies these categories:
- Dashboard (dashboard-related tasks)
- Todo System (todo/task management)
- Bug Fixes (fix/bug/error)
- Features (feature/add/implement)
- Testing (test/testing)
- Documentation (doc/document)
- UI/UX (ui/interface/button/display)
- Backend (api/backend/server)
- Refactoring (refactor/clean/optimize)
- Other (uncategorized)

### Hierarchy Creation
- Groups related tasks under parent tasks
- Preserves existing parent-child relationships
- Fixes orphaned sub-tasks

### Priority Sorting
- High priority items first
- Then medium priority
- Low priority last
- Within each priority, pending items come first

## For Claude

When asked to reorganize todos, you can:

1. **Check current status (non-interactive):**
   ```bash
   node todo-utils/todo-manager.js
   ```
   This shows all available projects, todo counts, and available commands, then exits immediately.

2. **Quick reorganization within projects:**
   ```bash
   node todo-utils/reorganize-todos.js
   ```
   Shows available projects and reorganizes todos within their current projects.

3. **Reorganize with specific options:**
   ```bash
   # Within projects only
   node todo-utils/todo-manager.js reorganize --hierarchy --sort
   
   # Move todos between projects based on content
   node todo-utils/todo-manager.js reorganize --cross-project --hierarchy --sort
   ```

4. **View current state for analysis:**
   ```bash
   # Get JSON data for analysis
   node todo-utils/todo-manager.js analyze
   
   # Export for Claude to read
   node todo-utils/export-todos.js claude
   cat todos-for-claude.md
   ```

5. **Backup and restore:**
   ```bash
   # Create backup
   node todo-utils/todo-manager.js backup my-label
   
   # List backups
   node todo-utils/todo-manager.js list-backups
   
   # Restore
   node todo-utils/todo-manager.js restore <backup-file>
   ```

6. **Interactive mode (only if needed):**
   ```bash
   node todo-utils/todo-manager.js interactive
   ```

### Available Projects/Sessions
The utilities now automatically show all available sessions/projects that todos can be organized into. This includes:
- All tmux sessions (claude-loop1, claude-loop2, etc.)
- Custom session names if configured
- Current todo counts per project

### Cross-Project Reorganization
When enabled (option 3 in interactive mode), the tool will:
- Analyze todo text for project mentions
- Move todos to appropriate projects based on content
- Handle special cases (e.g., "dashboard v2" → v2-related session)

## API Endpoints Used

These utilities interact with the dashboard API:

### Core Endpoints
- `GET /api/todos` - Fetch all todos
- `POST /api/todos` - Add a single new todo
- `PUT /api/todos/update` - Update single todo
- `POST /api/todos/bulk-update` - Update multiple existing todos (merges, doesn't replace)
- `POST /api/todos/bulk-add` - Add multiple new todos at once (requires 'project' field for safety)
- `POST /api/todos/reorder` - Update todo order and hierarchy

### Efficient Query Endpoints (New)
- `GET /api/todos/pending` - Get only pending todos
  - Optional: `?project=claude-loop9&priority=high&format=compact`
- `GET /api/todos/search` - Search todos with filters
  - Optional: `?q=searchtext&status=pending&project=x&format=compact`
- `GET /api/todos/project/:projectId` - Get todos for specific project

### Format Options
Add `?format=compact` to any endpoint for ~43% smaller responses.
Compact format returns only essential fields: id, text, status, priority, project.

## Notes

- The dashboard must be running (port 3335) for these utilities to work
- All operations that modify todos create automatic backups
- Backups older than 30 days are automatically cleaned up
- The utilities preserve all todo metadata (dates, notes, etc.)