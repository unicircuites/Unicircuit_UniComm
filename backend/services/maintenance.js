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

/**
 * Reconciles call counts in the contacts table with actual records in call_logs.
 */
async function reconcileCallCounts(pool) {
  console.log('[Maintenance] Starting call count reconciliation...');
  try {
    const contactsRes = await pool.query('SELECT id, phone, wa, fname, lname FROM contacts');
    const contacts = contactsRes.rows;
    
    let totalUpdated = 0;

    for (const c of contacts) {
      const nums = [c.phone, c.wa].filter(n => n && n.length > 5).map(n => n.replace(/\s+/g, ''));
      if (nums.length === 0) continue;

      // Build conditions matching the contact's number as the EXTERNAL party only.
      // For Inbound: contact is the caller (external → internal).
      // For Outbound: contact is the destination (internal → external).
      // Forwarded hops have an internal extension (≤5 digits) as caller, so they are
      // excluded naturally — preventing double-counting forwarded call chains.
      const conditions = [];
      const params = [];
      let p = 1;

      nums.forEach(n => {
        const last10 = n.slice(-10);
        // Inbound: caller matches (external caller)
        conditions.push(`(call_type = 'In'  AND caller      LIKE $${p})`);
        params.push(`%${last10}`);
        p++;
        conditions.push(`(call_type = 'In'  AND caller      LIKE $${p})`);
        params.push(`%${n}%`);
        p++;
        // Outbound: destination matches (external destination)
        conditions.push(`(call_type = 'Out' AND destination LIKE $${p})`);
        params.push(`%${last10}`);
        p++;
        conditions.push(`(call_type = 'Out' AND destination LIKE $${p})`);
        params.push(`%${n}%`);
        p++;
      });

      const countRes = await pool.query(
        `SELECT COUNT(*)::int AS n FROM call_logs WHERE ${conditions.join(' OR ')}`,
        params
      );

      const actualCount = countRes.rows[0].n;
      
      await pool.query(
        'UPDATE contacts SET calls = $1 WHERE id = $2',
        [actualCount, c.id]
      );
      totalUpdated++;
    }

    console.log(`[Maintenance] ✅ Reconciled call counts for ${totalUpdated} contacts.`);
    return totalUpdated;
  } catch (err) {
    console.error('[Maintenance] ❌ Reconciliation error:', err.message);
    throw err;
  }
}

module.exports = {
    pruneAntigravityLogs,
    reconcileCallCounts
};
