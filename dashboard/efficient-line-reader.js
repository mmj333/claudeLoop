const fs = require('fs');
const readline = require('readline');

/**
 * Efficiently read just the first line of a file
 * @param {string} filePath - Path to the file
 * @returns {Promise<string|null>} First line or null if empty
 */
async function readFirstLine(filePath) {
    return new Promise((resolve, reject) => {
        const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
        const rl = readline.createInterface({ input: stream });
        
        let firstLine = null;
        
        rl.on('line', (line) => {
            firstLine = line;
            rl.close();
            stream.destroy();
        });
        
        rl.on('close', () => {
            resolve(firstLine);
        });
        
        rl.on('error', (err) => {
            reject(err);
        });
        
        stream.on('error', (err) => {
            reject(err);
        });
    });
}

module.exports = { readFirstLine };