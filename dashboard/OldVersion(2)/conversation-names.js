/**
 * Custom conversation naming system
 * Allows users to assign meaningful names to conversation IDs
 */

const fs = require('fs').promises;
const path = require('path');

class ConversationNamer {
    constructor() {
        this.namesFile = path.join(__dirname, 'conversation-names.json');
        this.names = {};
        this.loaded = false;
    }
    
    async load() {
        if (this.loaded) return;
        
        try {
            const data = await fs.readFile(this.namesFile, 'utf8');
            this.names = JSON.parse(data);
            this.loaded = true;
        } catch (err) {
            // File doesn't exist or is corrupted, start fresh
            this.names = {};
            this.loaded = true;
        }
    }
    
    async save() {
        try {
            await fs.writeFile(this.namesFile, JSON.stringify(this.names, null, 2));
        } catch (err) {
            console.error('Error saving conversation names:', err);
        }
    }
    
    async setName(conversationId, name) {
        await this.load();
        this.names[conversationId] = {
            name: name,
            updatedAt: new Date().toISOString()
        };
        await this.save();
    }
    
    async getName(conversationId) {
        await this.load();
        const entry = this.names[conversationId];
        return entry ? entry.name : null;
    }
    
    async getAllNames() {
        await this.load();
        return { ...this.names };
    }
    
    async removeName(conversationId) {
        await this.load();
        delete this.names[conversationId];
        await this.save();
    }
}

module.exports = new ConversationNamer();