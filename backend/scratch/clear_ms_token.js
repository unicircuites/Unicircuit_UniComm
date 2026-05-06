const pool = require('../db/pool');
pool.query("DELETE FROM ms_tokens WHERE user_email = 'sales@unicircuites.com'")
  .then(r => { console.log('Deleted rows:', r.rowCount); pool.end(); })
  .catch(e => { console.error(e.message); pool.end(); });
