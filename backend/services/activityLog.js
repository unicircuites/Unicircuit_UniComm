// Ring buffer — max 500 events
// Event shape: { seq, type, service, message, timestamp }
// type: 'online' | 'offline' | 'error' | 'user_login'
// service: 'whatsapp' | 'pbx' | 'outlook' | 'postgres' | 'system'

const CAPACITY = 500;
let _buf = new Array(CAPACITY);
let _head = 0;   // next write position
let _count = 0;  // current fill level (0–500)
let _seq = 0;    // monotonically increasing

function append(event) {
  // validate required fields
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
  return stored;
}

function getRecent(n) {
  if (n <= 0) return [];
  const take = Math.min(n, _count);
  const result = [];
  // Walk backwards from (_head - 1) to get newest-last order
  // We want insertion order (oldest first, newest last)
  const start = (_head - _count + CAPACITY) % CAPACITY;
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

module.exports = { append, getRecent, getAll, size };
