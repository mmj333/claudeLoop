/**
 * Cache for Claude project path to actual directory mappings
 * This avoids reading files repeatedly for the same project
 */
class ProjectPathCache {
    constructor() {
        this.cache = new Map();
    }
    
    // Get cached path or null if not cached
    get(projectPath) {
        return this.cache.get(projectPath) || null;
    }
    
    // Set cached path
    set(projectPath, actualPath) {
        this.cache.set(projectPath, actualPath);
    }
    
    // Check if we have a cached value
    has(projectPath) {
        return this.cache.has(projectPath);
    }
    
    // Clear the cache (useful if directories change)
    clear() {
        this.cache.clear();
    }
    
    // Get cache size
    get size() {
        return this.cache.size;
    }
}

module.exports = new ProjectPathCache();