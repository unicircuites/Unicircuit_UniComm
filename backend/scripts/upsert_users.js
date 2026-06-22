require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const bcrypt = require('bcryptjs');
const pool = require('../db/pool');

function initialsFor(name) {
  return String(name || '')
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

function parseUsers() {
  const raw = process.env.UPSERT_USERS_JSON || process.argv[2];
  if (!raw) {
    throw new Error('Provide users as UPSERT_USERS_JSON or the first CLI argument.');
  }

  const users = JSON.parse(raw);
  if (!Array.isArray(users) || users.length === 0) {
    throw new Error('User payload must be a non-empty JSON array.');
  }

  for (const user of users) {
    if (!user.name || !user.email || !user.password) {
      throw new Error('Each user requires name, email, and password.');
    }
  }

  return users;
}

async function upsertUser(user) {
  const name = String(user.name).trim();
  const email = String(user.email).trim().toLowerCase();
  const role = user.role === 'admin' ? 'admin' : 'user';
  const password = String(user.password);
  const hash = await bcrypt.hash(password, 12);
  const initials = initialsFor(name);

  const result = await pool.query(
    `INSERT INTO users (name, email, password, plain_password, role, avatar_initials, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE)
     ON CONFLICT (email) DO UPDATE
       SET name = EXCLUDED.name,
           password = EXCLUDED.password,
           plain_password = EXCLUDED.plain_password,
           role = EXCLUDED.role,
           avatar_initials = EXCLUDED.avatar_initials,
           is_active = TRUE
     RETURNING id, name, email, role, is_active`,
    [name, email, hash, password, role, initials]
  );

  return result.rows[0];
}

async function main() {
  const users = parseUsers();
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS plain_password VARCHAR(255)`);

  for (const user of users) {
    const row = await upsertUser(user);
    console.log(`Upserted user #${row.id}: ${row.name} <${row.email}> (${row.role})`);
  }
}

main()
  .catch((err) => {
    console.error('User upsert failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
