const pool = require('./db/pool');
// Simulate what the chats query returns for this group
pool.query(`
  SELECT c.id, c.name AS chat_name, c.is_group,
    CASE WHEN c.is_group THEN c.name ELSE c.name END AS name
  FROM wa_chats c
  WHERE c.id = '120363361207108410@g.us'
`).then(r => { console.log('DB row:', JSON.stringify(r.rows[0], null, 2)); process.exit(); })
  .catch(e => { console.error(e.message); process.exit(1); });
