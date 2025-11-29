#!/usr/bin/env node

/**
 * Claude Message Monitor
 * Monitors Claude log files for specific messages and context status
 * Independent of which log monitor (JS or SH) is running
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Configuration
const LOG_DIR = '/home/michael/InfiniQuest/tmp/claudeLogs';
const CONFIG_DIR = '/home/michael/InfiniQuest/tmp/claudeLoop/dashboard';
const MONITORS_DIR = '/tmp/claude-monitors';
const CHECK_INTERVAL = 2000; // Check every 2 seconds

// Message patterns to watch for
const PATTERNS = {
    COMPACT_TRIGGERS: [
        /Let's compact!/i,
        /Finished everything for now!/i,
        /Done for now/i,
        /Everything is complete/i
    ],
    CONTEXT_LOW: /Context is getting low/i,
    CONTEXT_PERCENTAGE: /\[(\d+)%\s*used\]/,
    THINKING: /Thinking\.\.\.\s*(\d+)\s*seconds?/i,
    ERROR: /Error:|Failed:|Exception:/i,
    WAITING: /Waiting for|Please provide|What would you like/i
};

// Track state for each session
const sessionStates = new Map();

class SessionMonitor {
    constructor(sessionName) {
        this.sessionName = sessionName;
        this.logFile = path.join(LOG_DIR, `${sessionName}_${new Date().toISOString().split('T')[0]}.log`);
        this.configFile = path.join(CONFIG_DIR, `loop-config-${sessionName}.json`);
        this.lastSize = 0;
        this.lastCompactLine = 0;
        this.contextPercentage = 100;
        this.isThinking = false;
        this.thinkingStartTime = null;
    }

    async loadConfig() {
        try {
            const configData = await fs.promises.readFile(this.configFile, 'utf8');
            this.config = JSON.parse(configData);
            return true;
        } catch (error) {
            console.error(`[${this.sessionName}] Failed to load config:`, error.message);
            return false;
        }
    }

    async checkLog() {
        try {
            const stats = await fs.promises.stat(this.logFile);
            
            // Only read new content
            if (stats.size <= this.lastSize) {
                return;
            }

            // Read the new portion
            const stream = fs.createReadStream(this.logFile, {
                start: Math.max(0, this.lastSize - 1000), // Read a bit before to ensure context
                end: stats.size
            });

            let newContent = '';
            for await (const chunk of stream) {
                newContent += chunk.toString();
            }

            this.lastSize = stats.size;

            // Process the new content
            await this.processContent(newContent);
        } catch (error) {
            // File might not exist yet, that's okay
            if (error.code !== 'ENOENT') {
                console.error(`[${this.sessionName}] Error reading log:`, error.message);
            }
        }
    }

    async processContent(content) {
        const lines = content.split('\n');
        
        for (const line of lines) {
            // Check for context percentage
            const contextMatch = line.match(PATTERNS.CONTEXT_PERCENTAGE);
            if (contextMatch) {
                this.contextPercentage = parseInt(contextMatch[1]);
                console.log(`[${this.sessionName}] Context: ${this.contextPercentage}%`);
            }

            // Check for thinking status
            const thinkingMatch = line.match(PATTERNS.THINKING);
            if (thinkingMatch) {
                const seconds = parseInt(thinkingMatch[1]);
                if (!this.isThinking) {
                    this.isThinking = true;
                    this.thinkingStartTime = Date.now() - (seconds * 1000);
                    console.log(`[${this.sessionName}] Claude is thinking...`);
                }
            } else if (this.isThinking && (line.includes('●') || line.includes('>'))) {
                // Claude responded
                this.isThinking = false;
                const duration = Math.round((Date.now() - this.thinkingStartTime) / 1000);
                console.log(`[${this.sessionName}] Claude finished thinking (${duration}s)`);
            }

            // Check for compact triggers
            if (this.config?.conditionalMessages?.lowContextMessage?.autoCompact) {
                for (const pattern of PATTERNS.COMPACT_TRIGGERS) {
                    if (pattern.test(line)) {
                        console.log(`[${this.sessionName}] Compact trigger detected: "${line.trim()}"`);
                        await this.triggerCompact();
                        break;
                    }
                }
            }

            // Check for errors
            if (PATTERNS.ERROR.test(line)) {
                console.log(`[${this.sessionName}] Error detected: "${line.trim()}"`);
            }

            // Check if Claude is waiting
            if (PATTERNS.WAITING.test(line)) {
                console.log(`[${this.sessionName}] Claude is waiting for input`);
            }
        }
    }

    async triggerCompact() {
        console.log(`[${this.sessionName}] Sending /compact command...`);
        
        try {
            // Send /compact to the tmux session
            const tmuxCmd = spawn('tmux', [
                'send-keys', '-t', this.sessionName,
                '/compact', 'Enter'
            ]);

            tmuxCmd.on('close', (code) => {
                if (code === 0) {
                    console.log(`[${this.sessionName}] Compact command sent successfully`);
                    
                    // Pause the loop after 2 seconds
                    setTimeout(() => {
                        this.pauseLoop();
                    }, 2000);
                } else {
                    console.error(`[${this.sessionName}] Failed to send compact command`);
                }
            });
        } catch (error) {
            console.error(`[${this.sessionName}] Error triggering compact:`, error.message);
        }
    }

    async pauseLoop() {
        try {
            const response = await fetch('http://localhost:3335/api/loop/pause', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session: this.sessionName })
            });
            
            if (response.ok) {
                const result = await response.json();
                console.log(`[${this.sessionName}] Loop paused via API:`, result.message);
            } else {
                const error = await response.json();
                console.error(`[${this.sessionName}] Failed to pause loop:`, error.error);
            }
        } catch (error) {
            console.error(`[${this.sessionName}] Failed to pause loop:`, error.message);
        }
    }

    getStatus() {
        return {
            session: this.sessionName,
            context: this.contextPercentage,
            isThinking: this.isThinking,
            thinkingDuration: this.isThinking ? 
                Math.round((Date.now() - this.thinkingStartTime) / 1000) : 0,
            logSize: this.lastSize
        };
    }
}

// Monitor all active sessions
async function findActiveSessions() {
    const sessions = new Set();
    
    try {
        // Check for running tmux sessions
        const tmuxList = spawn('tmux', ['list-sessions', '-F', '#{session_name}']);
        let output = '';
        
        for await (const chunk of tmuxList.stdout) {
            output += chunk.toString();
        }
        
        output.split('\n').forEach(session => {
            if (session.startsWith('claude-loop')) {
                sessions.add(session.trim());
            }
        });
    } catch (error) {
        // No tmux sessions, that's okay
    }
    
    // Also check for recent log files
    try {
        const files = await fs.promises.readdir(LOG_DIR);
        const today = new Date().toISOString().split('T')[0];
        
        files.forEach(file => {
            if (file.includes(today) && file.startsWith('claude-loop')) {
                const session = file.split('_')[0];
                sessions.add(session);
            }
        });
    } catch (error) {
        console.error('Error reading log directory:', error.message);
    }
    
    return Array.from(sessions);
}

// API server for status queries
function startStatusServer() {
    const http = require('http');
    const PORT = 3458;
    
    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        if (req.url === '/status') {
            const statuses = Array.from(sessionStates.values()).map(monitor => monitor.getStatus());
            res.writeHead(200);
            res.end(JSON.stringify({ sessions: statuses }));
        } else {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Not found' }));
        }
    });
    
    server.listen(PORT, () => {
        console.log(`Status server listening on port ${PORT}`);
    });
}

// Main monitoring loop
async function main() {
    console.log('Claude Message Monitor starting...');
    console.log(`Monitoring logs in: ${LOG_DIR}`);
    console.log('');
    
    // Start status server
    startStatusServer();
    
    // Monitor loop
    setInterval(async () => {
        const activeSessions = await findActiveSessions();
        
        // Add new sessions
        for (const session of activeSessions) {
            if (!sessionStates.has(session)) {
                console.log(`[${session}] Starting monitor...`);
                const monitor = new SessionMonitor(session);
                if (await monitor.loadConfig()) {
                    sessionStates.set(session, monitor);
                }
            }
        }
        
        // Remove inactive sessions
        for (const [session, monitor] of sessionStates) {
            if (!activeSessions.includes(session)) {
                console.log(`[${session}] Removing inactive monitor`);
                sessionStates.delete(session);
            }
        }
        
        // Check all active monitors
        for (const monitor of sessionStates.values()) {
            await monitor.checkLog();
        }
    }, CHECK_INTERVAL);
    
    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('\nShutting down...');
        process.exit(0);
    });
}

// Start monitoring
main().catch(console.error);