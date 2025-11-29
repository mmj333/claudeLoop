# Todo System - Complete Feature Guide

## Table of Contents
1. [History System](#history-system)
2. [Dashboard UI Features](#dashboard-ui-features)
3. [API Reference](#api-reference)
4. [Export Formats](#export-formats)
5. [Advanced Reorganization](#advanced-reorganization)
6. [Claude Workflow Tips](#claude-workflow-tips)

---

## History System

### Event Sourcing Architecture
All todo changes are logged as immutable events in `history/changes.jsonl`:
- Every change creates a new event (never modifies existing ones)
- Full audit trail of all modifications
- Supports time-travel debugging

### Undo/Redo Per Todo
Each todo maintains its own undo/redo stack:
```bash
# Via API
POST /api/todos/undo/:todoId
POST /api/todos/redo/:todoId

# In dashboard
- Hover over todo to see undo/redo buttons
- Click to revert/reapply changes
```

### Checkpoints (System Snapshots)
Save complete system state at a point in time:
```bash
# Create checkpoint
POST /api/todos/checkpoints
{
  "name": "before-major-reorganization"
}

# List checkpoints
GET /api/todos/checkpoints

# Restore from checkpoint
POST /api/todos/restore-checkpoint
{
  "filename": "checkpoint-2025-08-27T02-00-00.json"
}
```

### Automatic History Cleanup
Old history automatically removed after 30 days to prevent bloat.

---

## Dashboard UI Features

### Double-Click Inline Editing
- Double-click any todo text to edit in place
- Edit box auto-sizes to match text
- Press Enter to save, Escape to cancel
- No page refresh needed

### Drag & Drop Organization
- Drag todos to reorder
- Drag to right to make sub-task
- Drag to left to promote to parent
- Visual feedback during drag
- Auto-saves position

### Date Range Filtering
Each status has its own date filter:
- **Pending**: Filter by creation date
- **Claude Done**: Filter by completion date  
- **User Approved**: Filter by approval date

Options: Today, 24h, 48h, 7d, 30d, All

### Multi-Status Filtering
- Check multiple status boxes to see combined results
- Selections persist across sessions
- Independent of date filters

### Project Folder Navigation
- Click any project folder to filter todos
- Visual highlighting of active project
- Todo counts per project
- Drag todos to folders to reassign

### Per-Todo Undo/Redo Buttons
- Appear on hover when history exists
- Shows number of available undos
- One-click revert
- Preserves all metadata

---

## API Reference

### Efficient Query Endpoints

#### GET /api/todos/pending
```bash
# Basic
GET /api/todos/pending

# With filters
GET /api/todos/pending?project=claude-loop9&priority=high

# Compact format (43% smaller)
GET /api/todos/pending?format=compact
```

#### GET /api/todos/search
```bash
# Text search
GET /api/todos/search?q=dashboard

# Combined filters
GET /api/todos/search?q=bug&status=pending&project=claude-loop9&format=compact
```

#### GET /api/todos/project/:id
```bash
# All todos for a project
GET /api/todos/project/claude-loop9

# Returns todos regardless of status
```

### Update Operations

#### PUT /api/todos/update
Update single todo:
```json
{
  "id": "abc123",
  "status": "claude_done",
  "notes": ["Fixed the issue"]
}
```

#### POST /api/todos/bulk-update
Update multiple todos:
```json
{
  "todos": [
    {"id": "abc123", "status": "claude_done"},
    {"id": "def456", "priority": "high"}
  ]
}
```

### History Operations

#### GET /api/todos/history/:todoId
Get complete history for a todo:
```json
{
  "history": [...],
  "currentPosition": 5,
  "canUndo": true,
  "canRedo": false
}
```

---

## Export Formats

### Claude Format
Optimized for Claude's context window:
```bash
node todo-utils/export-todos.js claude
```
- Groups by status and priority
- Minimal formatting
- Includes only essential fields
- Perfect for status reports

### Markdown with Hierarchy
Preserves parent-child relationships:
```bash
node todo-utils/export-todos.js markdown todos.md
```
- Nested lists for sub-tasks
- Status badges
- Priority indicators
- Timestamps

### CSV for Analysis
```bash
node todo-utils/export-todos.js csv todos.csv
```
- All fields included
- Excel-compatible
- Date formatting preserved

---

## Advanced Reorganization

### Smart Categorization
The reorganizer auto-detects categories:
- **Dashboard**: dashboard, ui, interface
- **Bug Fixes**: fix, bug, error, issue
- **Features**: feature, add, implement
- **Testing**: test, testing, spec
- **Documentation**: doc, readme, document
- **Backend**: api, backend, server
- **Refactoring**: refactor, clean, optimize

### Cross-Project Movement
Move todos between projects based on content:
```bash
node todo-utils/todo-manager.js reorganize --cross-project
```
- Analyzes todo text for project mentions
- Moves to appropriate project
- Preserves all metadata

### Priority-Based Sorting
Automatic sorting order:
1. High priority pending
2. Normal priority pending  
3. Low priority pending
4. In-progress items
5. Completed items

### Hierarchy Creation Rules
- Groups related todos by keywords
- Preserves existing parent-child relationships
- Creates logical task groups
- Never creates duplicate parents

---

## Claude Workflow Tips

### Session Start Workflow
```bash
# 1. Set your session
export CLAUDE_SESSION=claude-loop9

# 2. Claim your next task
node todo-utils/claim-next.js

# 3. Or just check what's available
node todo-utils/get-next.js
```

### Efficient Querying
```bash
# Get only what you need
curl 'http://localhost:3335/api/todos/pending?project=claude-loop9&format=compact'

# Search for specific work
curl 'http://localhost:3335/api/todos/search?q=bug&status=pending&format=compact'
```

### Status Workflow
1. **Pending** → Task in queue
2. **In Progress** → Claude claimed it
3. **Claude Done** → Claude completed
4. **User Approved** → User verified

### Integration with Native Todos
- Dashboard = Queue of work
- Native = Current conversation work
- Claim system bridges both
- Status syncs automatically (coming soon)

### Best Practices
- Use `format=compact` for all queries (43% smaller)
- Filter by project to reduce noise
- Claim tasks to prevent duplicate work
- Use checkpoints before major changes
- Let reorganizer group related work

---

## Hidden Features

### Keyboard Shortcuts (Dashboard)
- **Double-click**: Inline edit
- **Drag+Shift**: Move to different project
- **Hover**: Show undo/redo buttons

### URL Parameters
- `?session=claude-loop9` - Auto-select session
- `?todo-project=x` - Filter by project on load

### localStorage Keys
- `selected-todo-statuses` - Filter preferences
- `todo-date-ranges` - Date filter settings
- `project-sidebar-open` - Sidebar state
- `todo-project-filter` - Active project filter

### Performance Tips
- Compact format reduces payload 43%
- Pending endpoint avoids fetching completed todos
- Project filtering happens server-side
- History is append-only (fast writes)