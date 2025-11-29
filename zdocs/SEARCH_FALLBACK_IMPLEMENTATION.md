# Search-Based Fallback for Wild Filenames

## Problem Statement

Claude's project folder naming scheme converts filesystem paths like `/home/michael/Projects/Computers_Plus_Repair` into folder names like `-home-michael-Projects-Computers-Plus-Repair`. However, the reverse conversion is ambiguous because:

- Dashes can represent: `/` (slash), `_` (underscore), ` ` (space), or literal `-` (dash)
- Complex filenames like `A-_ b__- C-- -__` create impossible-to-parse combinations

Our incremental path-building algorithm handles most cases, but extremely wild filenames require a fallback strategy.

## Solution: Hybrid Incremental + Search Approach

### Stage 1: Incremental Path Building (Primary)
The algorithm builds paths step-by-step, testing filesystem at each level:

```javascript
// For "-home-michael-Projects-Computers-Plus-Repair"
currentPath = '/home'           // Check: exists ✓
currentPath = '/home/michael'   // Check: exists ✓
currentPath = '/home/michael/Projects'  // Check: exists ✓
// Try: /home/michael/Projects/Computers    ✗
// Try: /home/michael/Projects Computers   ✗
// Try: /home/michael/Projects_Computers   ✗
// None exist, try remaining parts...
```

At each step, tries three delimiters in order:
1. Slash (`/`) - most common for directories
2. Space (` `) - common for user-created folders
3. Underscore (`_`) - alternative to spaces

### Stage 2: Multi-Part Name Check (Secondary)
If single-step fails, tries joining remaining parts with different delimiters:

```javascript
// Remaining parts: ["Computers", "Plus", "Repair"]
// Try: /home/michael/Projects/Computers Plus Repair  ✗
// Try: /home/michael/Projects/Computers_Plus_Repair  ✓
```

### Stage 3: Search-Based Fuzzy Matching (Last Resort)
If all deterministic attempts fail, searches parent directory for matching folders:

```javascript
searchForFolder('/home/michael/Projects', 'ComputersPlusRepair')
// Strips all delimiters from target: "computersplusrepair"
// Lists all folders in parent: ["Computers_Plus_Repair", "Other Folder"]
// Strips delimiters from each: ["computersplusrepair", "otherfolder"]
// Returns first match: "/home/michael/Projects/Computers_Plus_Repair"
```

### Stage 4: Final Fallback Check
After path is fully built, verifies it exists. If not, walks back to last existing ancestor and searches from there:

```javascript
// Computed path: /home/michael/Projects/Computers/Plus/Repair
if (!existsSync(currentPath)) {
    // Walk back to find last existing path
    // lastGood = /home/michael/Projects
    // target = Computers/Plus/Repair
    searchForFolder(lastGood, target)
}
```

## Implementation Details

### searchForFolder() Method

Location: `conversation-tree-scanner.js:30-69`

```javascript
searchForFolder(parentPath, targetName) {
    // Strip all delimiters from target and folder names
    const cleanTarget = targetName.replace(/[-\s\/_]/g, '').toLowerCase();

    // Find exact matches when stripped
    const matches = folders.map(folder => ({
        folder,
        cleanFolder: folder.replace(/[-\s\/_]/g, '').toLowerCase(),
        matches: cleanFolder === cleanTarget
    })).filter(m => m.matches);

    // Return first match
    return matches.length > 0 ? path.join(parentPath, matches[0].folder) : null;
}
```

### Integration Points

1. **Line 113-119**: During incremental building when all delimiter attempts fail
2. **Line 133-151**: Final verification check after path is fully built

### Caching Strategy

All results (successful or failed) are cached in `this.pathCache[projectFolder]`:
- Successful searches: Cache actual path found
- Failed searches: Cache best-guess path
- Prevents repeated filesystem searches for same project folder

## Edge Cases Handled

### Case 1: Simple Mixed Delimiters
```
Folder: "Computers_Plus Repair"
Claude: "-Computers-Plus-Repair"
Result: /Computers_Plus Repair ✓
```

### Case 2: Literal Dashes
```
Folder: "Project--Name"
Claude: "-Project---Name"
Result: /Project-Name ✓
```

### Case 3: Wild Combinations
```
Folder: "A-_ b__- C-- -__"
Claude: "-A---b-----C------"
Incremental: Fails ✗
Search: Finds "A-_ b__- C-- -__" ✓
```

### Case 4: Deeply Nested Unknown
```
Computed: /home/michael/Wrong/Path/Here
Exists: /home/michael/Right_Path/Here
Search: Walks back to /home/michael, searches for "RightPathHere" ✓
```

## Performance Considerations

### When Search Kicks In
- **Rare**: Only when deterministic methods fail
- **Localized**: Only searches immediate parent directory
- **Cached**: Results cached to prevent repeated searches

### Worst Case Performance
- **282 conversations** in same project
- **1 search** per unique project folder (cached after first)
- **Search cost**: O(n) where n = folders in parent directory

### Example Performance
```
Conversations: 282 all in "/home/michael/Projects/Computers_Plus_Repair"
First conversation: Incremental build (10 checks) + Final search (1 search)
Remaining 281: Cache hit (0 checks, 0 searches)
```

## Testing Recommendations

Create test folders with wild names:
```bash
mkdir -p "/tmp/test/A-_ b__- C"
mkdir -p "/tmp/test/Project--Name"
mkdir -p "/tmp/test/Folder With Spaces"
mkdir -p "/tmp/test/Under_Score_Name"
```

Then test parsing:
```javascript
scanner.parseFolderNameToPath('-tmp-test-A---b-----C')
scanner.parseFolderNameToPath('-tmp-test-Project---Name')
scanner.parseFolderNameToPath('-tmp-test-Folder-With-Spaces')
scanner.parseFolderNameToPath('-tmp-test-Under-Score-Name')
```

## Future Improvements

1. **Levenshtein distance**: Instead of exact stripped match, use fuzzy string matching
2. **Multiple matches**: If multiple folders match stripped name, use heuristics to choose best
3. **Search radius**: Expand search to grandparent/ancestors if no match in parent
4. **User feedback**: Log warning when search fallback is used, suggesting user rename folder

## Related Files

- `conversation-tree-scanner.js` - Main implementation
- `dashboard.html` - Conversation tree display
- `/home/michael/.claude/conversation-tree-cache.json` - Parsed path cache

## Changelog

- **2025-07-XX**: Initial implementation of hybrid incremental + search approach
- **2025-07-XX**: Added caching for performance optimization
- **2025-07-XX**: Enhanced to handle spaces, underscores, and literal dashes
