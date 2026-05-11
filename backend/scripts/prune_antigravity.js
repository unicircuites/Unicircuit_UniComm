const fs = require('fs');
const path = require('path');
const os = require('os');

const CONVERSATIONS_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'conversations');

async function pruneConversations(maxFiles = 50, maxSizeMB = 10) {
    console.log(`[Antigravity Cleanup] Checking directory: ${CONVERSATIONS_DIR}`);
    
    if (!fs.existsSync(CONVERSATIONS_DIR)) {
        console.error('Directory does not exist.');
        return;
    }

    try {
        const files = fs.readdirSync(CONVERSATIONS_DIR)
            .filter(file => file.endsWith('.pb'))
            .map(file => {
                const filePath = path.join(CONVERSATIONS_DIR, file);
                const stats = fs.statSync(filePath);
                return {
                    name: file,
                    path: filePath,
                    size: stats.size / (1024 * 1024), // MB
                    mtime: stats.mtime
                };
            });

        console.log(`Found ${files.length} conversation logs.`);

        // 1. Delete files larger than maxSizeMB
        const oversized = files.filter(f => f.size > maxSizeMB);
        oversized.forEach(f => {
            console.log(`Deleting oversized file: ${f.name} (${f.size.toFixed(2)} MB)`);
            fs.unlinkSync(f.path);
        });

        // 2. Keep only the most recent N files
        const remaining = fs.readdirSync(CONVERSATIONS_DIR)
            .filter(file => file.endsWith('.pb'))
            .map(file => {
                const filePath = path.join(CONVERSATIONS_DIR, file);
                const stats = fs.statSync(filePath);
                return { name: file, path: filePath, mtime: stats.mtime };
            })
            .sort((a, b) => b.mtime - a.mtime);

        if (remaining.length > maxFiles) {
            const toDelete = remaining.slice(maxFiles);
            toDelete.forEach(f => {
                console.log(`Deleting old file: ${f.name} (${f.mtime.toLocaleDateString()})`);
                fs.unlinkSync(f.path);
            });
        }

        console.log('[Antigravity Cleanup] Finished pruning.');
    } catch (err) {
        console.error('Error during pruning:', err.message);
    }
}

// Run immediately
pruneConversations(20, 5);
