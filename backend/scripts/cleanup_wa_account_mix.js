const pool = require('../db/pool');

function arg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : '';
}

function phoneVariants(value) {
  const digits = String(value || '').replace(/\D/g, '');
  const set = new Set();
  if (digits) set.add(digits);
  if (digits.length === 10) set.add(`91${digits}`);
  if (digits.length === 12 && digits.startsWith('91')) set.add(digits.slice(2));
  return Array.from(set);
}

async function countDuplicates(client, table, keyColumns, sourceAccounts, targetAccounts) {
  const join = keyColumns.map(col => `src.${col} = tgt.${col}`).join(' AND ');
  const sql = `
    SELECT COUNT(*)::int AS count
    FROM ${table} tgt
    WHERE tgt.account_phone = ANY($2::text[])
      AND EXISTS (
        SELECT 1
        FROM ${table} src
        WHERE src.account_phone = ANY($1::text[])
          AND ${join}
      )
  `;
  const result = await client.query(sql, [sourceAccounts, targetAccounts]);
  return result.rows[0]?.count || 0;
}

async function deleteDuplicates(client, table, keyColumns, sourceAccounts, targetAccounts) {
  const join = keyColumns.map(col => `src.${col} = tgt.${col}`).join(' AND ');
  const sql = `
    DELETE FROM ${table} tgt
    WHERE tgt.account_phone = ANY($2::text[])
      AND EXISTS (
        SELECT 1
        FROM ${table} src
        WHERE src.account_phone = ANY($1::text[])
          AND ${join}
      )
  `;
  const result = await client.query(sql, [sourceAccounts, targetAccounts]);
  return result.rowCount || 0;
}

async function main() {
  const sourceAccounts = phoneVariants(arg('source'));
  const targetAccounts = phoneVariants(arg('target'));
  const apply = process.argv.includes('--apply');

  if (!sourceAccounts.length || !targetAccounts.length) {
    throw new Error('Usage: node backend/scripts/cleanup_wa_account_mix.js --source 9545073545 --target 9359475770 [--apply]');
  }

  const tables = [
    ['wa_messages', ['id', 'chat_id']],
    ['wa_chats', ['id']],
    ['wa_contacts', ['jid']],
  ];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const report = {};
    for (const [table, keys] of tables) {
      report[table] = apply
        ? await deleteDuplicates(client, table, keys, sourceAccounts, targetAccounts)
        : await countDuplicates(client, table, keys, sourceAccounts, targetAccounts);
    }
    if (apply) await client.query('COMMIT');
    else await client.query('ROLLBACK');

    console.log(JSON.stringify({
      mode: apply ? 'applied' : 'dry-run',
      sourceAccounts,
      targetAccounts,
      duplicates: report,
    }, null, 2));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('[WA cleanup] Failed:', err.message);
  process.exitCode = 1;
});
