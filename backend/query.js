const { Pool } = require('pg'); 
const pool = new Pool({ connectionString: 'postgres://postgres:postgres@localhost:5432/unicomm_db' }); 
pool.query('UPDATE wa_chats SET name = $1 WHERE id = $2', ['Daily triggers HGW', '120363402503162424@g.us'])
  .then(() => { console.log('Updated Meta AI group name to Daily triggers HGW'); pool.end(); })
  .catch(console.error);
