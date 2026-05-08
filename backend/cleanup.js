const pool = require('./db/pool');

async function clean() {
  try {
    console.log('Cleaning up duplicate imported messages...');
    // Delete any messages that were imported manually (they all start with import_)
    await pool.query(`DELETE FROM wa_messages WHERE id LIKE 'import_%'`);
    // Delete any mistakenly created duplicate import chats
    await pool.query(`DELETE FROM wa_chats WHERE id LIKE 'import_%'`);
    console.log('Cleanup complete! You can now re-import safely without duplicate bubbles.');
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    process.exit(0);
  }
}

clean();
