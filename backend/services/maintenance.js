const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Prunes the Antigravity conversation logs to prevent I/O latency.
 * Policy: 
 * 1. Remove files > 5MB
 * 2. Remove files older than 7 days
 * 3. Keep at least the 20 most recent files
 */
async function pruneAntigravityLogs() {
    const conversationsDir = path.join(os.homedir(), '.gemini', 'antigravity', 'conversations');
    
    if (!fs.existsSync(conversationsDir)) {
        console.log('[Maintenance] Antigravity conversations directory not found. Skipping pruning.');
        return;
    }

    try {
        const files = fs.readdirSync(conversationsDir)
            .filter(file => file.endsWith('.pb'))
            .map(file => {
                const filePath = path.join(conversationsDir, file);
                const stats = fs.statSync(filePath);
                return {
                    name: file,
                    path: filePath,
                    size: stats.size,
                    mtime: stats.mtime
                };
            });

        // Sort by modification time (descending: newest first)
        files.sort((a, b) => b.mtime - a.mtime);

        const keepFiles = files.slice(0, 20);
        const candidateFiles = files.slice(20);

        let deletedCount = 0;
        let reclaimedBytes = 0;

        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        for (const file of candidateFiles) {
            const isTooLarge = file.size > 5 * 1024 * 1024; // 5MB
            const isTooOld = file.mtime < sevenDaysAgo;

            if (isTooLarge || isTooOld) {
                fs.unlinkSync(file.path);
                deletedCount++;
                reclaimedBytes += file.size;
            }
        }

        if (deletedCount > 0) {
            console.log(`[Maintenance] Pruned ${deletedCount} legacy logs. Reclaimed ${(reclaimedBytes / (1024 * 1024)).toFixed(2)} MB.`);
        } else {
            console.log('[Maintenance] No Antigravity logs met the pruning criteria.');
        }
    } catch (err) {
        console.error('[Maintenance] Error pruning Antigravity logs:', err.message);
    }
}

module.exports = {
    pruneAntigravityLogs
};
