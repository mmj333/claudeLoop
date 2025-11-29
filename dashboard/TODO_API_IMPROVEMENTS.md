# Todo API Improvements Plan

## Priority 1: Search & Filter Endpoints (Most Critical)

### 1. GET /api/todos/pending
- Returns only pending todos
- Optional query params: ?project=claude-loop9&priority=high
- Reduces over-fetching by ~80%

### 2. GET /api/todos/search
- Query params: ?q=searchtext&status=pending&project=x&category=y
- Full-text search in todo text and notes
- Multiple filter combinations

### 3. GET /api/todos/project/:projectId
- Get todos for specific project only
- Useful for session-specific work

## Priority 2: Bulk Operations

### 4. POST /api/todos/bulk-status
```json
{
  "ids": ["id1", "id2"],
  "status": "claude_done"
}
```

### 5. POST /api/todos/batch-create
- Create multiple todos with hierarchy in one call
```json
{
  "todos": [
    {"text": "Parent task", "subtasks": [
      {"text": "Subtask 1"},
      {"text": "Subtask 2"}
    ]}
  ]
}
```

## Priority 3: Claude-Specific Tools

### 6. GET /api/todos/next
- Returns the highest priority pending todo for current session
- Smart selection based on priority, age, and project

### 7. GET /api/todos/summary
- Returns counts only, no full todo objects
```json
{
  "pending": 45,
  "claude_done": 12,
  "user_approved": 89,
  "by_project": {"claude-loop9": 15, ...}
}
```

## Priority 4: Simple CLI Commands

### 8. todo-utils/get-next.js
- Single command to get next task
- Output format: "ID: text [priority]"

### 9. todo-utils/mark-done.js <id>
- Simple command to mark todo as claude_done
- Logs to history automatically

### 10. todo-utils/quick-add.js "text" [project] [priority]
- Fast todo creation without complex JSON

## Implementation Order

1. **Start with search/filter endpoints** - Biggest efficiency gain
2. **Add bulk operations** - Reduce multiple API calls
3. **Create simple CLI wrappers** - Make Claude's life easier
4. **Add smart endpoints** - Quality of life improvements

## Current Pain Points This Solves

- **Over-fetching**: Currently fetching 100% of todos when needing 5%
- **Manual filtering**: Claude has to filter in memory after fetching
- **Multiple API calls**: Batch operations require loops
- **Complex commands**: Too many options when simple would suffice

## Success Metrics

- Reduce average API response size by 80%
- Reduce number of API calls for batch operations by 75%
- Simplify common operations to single commands
- Enable "get next task" in under 100ms

## Notes

- All new endpoints should integrate with existing history system
- Maintain backward compatibility with current tools
- Consider adding caching for frequently accessed queries
- Keep responses lean - return IDs when possible, full objects only when needed