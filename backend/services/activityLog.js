// Ring buffer — max 500 events, persisted to PostgreSQL
// Event shape: { seq, type, service, message, timestamp }
// type: 'online' | 'offline' | 'error' | 'user_login' | 'info'
// service: 'whatsapp' | 'pbx' | 'outlook' | 'postgres' | 'system'

const CAPACITY = 500;
let _buf = new Array(CAPACITY);
let _head = 0;
let _count = 0;
let _seq = 0;
let _pool = null; // set via init()

// ── DB persistence ────────────────────────────────────────────────────────
async function ensureTable() {
  if (!_pool) return;
  try {
    await _pool.query(`
      CREATE TABLE IF NOT EXISTS system_activity_log (
        id         SERIAL PRIMARY KEY,
        seq        INT NOT NULL,
        type       VARCHAR(20) NOT NULL,
        service    VARCHAR(30) NOT NULL,
        message    TEXT NOT NULL,
        timestamp  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await _pool.query(`CREATE INDEX IF NOT EXISTS idx_sal_timestamp ON system_activity_log (timestamp DESC)`);
  } catch (err) {
    console.warn('[ActivityLog] Could not create table:', err.message);
  }
}

async function saveToDb(event) {
  if (!_pool) return;
  try {
    await _pool.query(
      `INSERT INTO system_activity_log (seq, type, service, message, timestamp)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [event.seq, event.type, event.service, event.message, event.timestamp]
    );
    // Keep only last 500 rows in DB
    _pool.query(
      `DELETE FROM system_activity_log WHERE id NOT IN (
         SELECT id FROM system_activity_log ORDER BY timestamp DESC LIMIT 500
       )`
    ).catch(() => {});
  } catch (_) {}
}

async function loadFromDb() {
  if (!_pool) return;
  try {
    const res = await _pool.query(
      `SELECT seq, type, service, message, timestamp::text AS timestamp
       FROM system_activity_log
       ORDER BY timestamp ASC
       LIMIT 500`
    );
    for (const row of res.rows) {
      const stored = { seq: row.seq, type: row.type, service: row.service, message: row.message, timestamp: row.timestamp };
      _buf[_head] = stored;
      _head = (_head + 1) % CAPACITY;
      if (_count < CAPACITY) _count++;
      if (row.seq > _seq) _seq = row.seq;
    }
    console.log(`[ActivityLog] Loaded ${res.rows.length} events from DB`);
  } catch (err) {
    console.warn('[ActivityLog] Could not load from DB:', err.message);
  }
}

/** Call once at startup with the pg pool */
async function init(pool) {
  _pool = pool;
  await ensureTable();
  await loadFromDb();
}

// ── Ring buffer ───────────────────────────────────────────────────────────
function append(event) {
  const required = ['type', 'service', 'message', 'timestamp'];
  for (const f of required) {
    if (event[f] === undefined || event[f] === null) {
      throw new TypeError(`activityLog.append: missing required field "${f}"`);
    }
  }
  _seq++;
  const stored = { seq: _seq, ...event };
  _buf[_head] = stored;
  _head = (_head + 1) % CAPACITY;
  if (_count < CAPACITY) _count++;
  // Persist to DB asynchronously (non-blocking)
  saveToDb(stored).catch(() => {});
  return stored;
}

function getRecent(n) {
  if (n <= 0) return [];
  const take = Math.min(n, _count);
  const start = (_head - _count + CAPACITY) % CAPACITY;
  const result = [];
  for (let i = 0; i < _count; i++) {
    result.push(_buf[(start + i) % CAPACITY]);
  }
  return result.slice(-take);
}

function getAll() {
  return getRecent(_count);
}

function size() {
  return _count;
}

module.exports = { init, append, getRecent, getAll, size };
