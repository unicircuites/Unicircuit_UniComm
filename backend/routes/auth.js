const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const pool    = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const activityLog = require('../services/activityLog');

const router = express.Router();

// ── POST /api/auth/login ───────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const result = await pool.query(
      `SELECT id, name, email, password, role, avatar_initials, is_active
       FROM users WHERE LOWER(email) = LOWER($1)`,
      [email.trim()]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const user = result.rows[0];

    if (!user.is_active) {
      return res.status(403).json({ error: 'Account is disabled. Contact your administrator.' });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    // Update last_login
    await pool.query(`UPDATE users SET last_login = NOW() WHERE id = $1`, [user.id]);

    // Audit log
    try {
      await pool.query(
        `INSERT INTO audit_log (user_id, action, entity, detail, ip) VALUES ($1,$2,$3,$4,$5)`,
        [user.id, 'LOGIN', 'users', `${user.email} logged in`, req.ip]
      );
    } catch (_) {}

    const payload = {
      id:       user.id,
      name:     user.name,
      email:    user.email,
      role:     user.role,
      initials: user.avatar_initials,
    };

    const token = jwt.sign(
      payload,
      process.env.JWT_SECRET || 'unicomm_secret',
      { expiresIn: process.env.JWT_EXPIRES || '8h' }
    );

    // Log user login to activity log
    try {
      activityLog.append({ type: 'user_login', service: 'system', message: `User logged in: ${user.name} (${user.email})`, timestamp: new Date().toISOString() });
    } catch (_) {}

    return res.json({ token, user: payload });

  } catch (err) {
    console.error('[Auth] Login error:', err.message);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ── POST /api/auth/logout ──────────────────────────────────────────────────
router.post('/logout', authenticate, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO audit_log (user_id, action, entity, detail, ip) VALUES ($1,$2,$3,$4,$5)`,
      [req.user.id, 'LOGOUT', 'users', `${req.user.email} logged out`, req.ip]
    );
  } catch (_) {}
  return res.json({ message: 'Logged out.' });
});

// ── GET /api/auth/me ───────────────────────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, role, avatar_initials, last_login, created_at FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'User not found.' });
    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /api/auth/change-password ────────────────────────────────────────
router.post('/change-password', authenticate, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Both current and new password are required.' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }
  try {
    const result = await pool.query(`SELECT password FROM users WHERE id = $1`, [req.user.id]);
    const match  = await bcrypt.compare(currentPassword, result.rows[0].password);
    if (!match) return res.status(401).json({ error: 'Current password is incorrect.' });

    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query(`UPDATE users SET password = $1 WHERE id = $2`, [hash, req.user.id]);
    return res.json({ message: 'Password updated successfully.' });
  } catch (err) {
    return res.status(500).json({ error: 'Server error.' });
  }
});

// ── Admin-only middleware ─────────────────────────────────────────────────
function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  next();
}

// ── GET /api/auth/users ───────────────────────────────────────────────────
router.get('/users', authenticate, adminOnly, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, email, role, is_active, avatar_initials, created_at, last_login FROM users ORDER BY created_at`
  );
  return res.json({ users: rows });
});

// ── POST /api/auth/users ──────────────────────────────────────────────────
router.post('/users', authenticate, adminOnly, async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const initials = name.trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password, role, avatar_initials) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, email, role, is_active, avatar_initials, created_at`,
      [name.trim(), email.trim().toLowerCase(), hash, role === 'admin' ? 'admin' : 'user', initials]
    );
    return res.status(201).json({ user: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists.' });
    return res.status(500).json({ error: 'Server error.' });
  }
});

// ── PUT /api/auth/users/:id ───────────────────────────────────────────────
router.put('/users/:id', authenticate, adminOnly, async (req, res) => {
  const { name, email, role, is_active, password } = req.body;
  const id = parseInt(req.params.id);
  try {
    if (password) {
      if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
      const hash = await bcrypt.hash(password, 12);
      await pool.query(`UPDATE users SET password = $1 WHERE id = $2`, [hash, id]);
    }
    const initials = name ? name.trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2) : undefined;
    const { rows } = await pool.query(
      `UPDATE users SET name = COALESCE($1, name), email = COALESCE($2, email), role = COALESCE($3, role),
       is_active = COALESCE($4, is_active), avatar_initials = COALESCE($5, avatar_initials)
       WHERE id = $6 RETURNING id, name, email, role, is_active, avatar_initials, created_at`,
      [name?.trim() || null, email?.trim().toLowerCase() || null, role || null, is_active ?? null, initials || null, id]
    );
    return res.json({ user: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists.' });
    return res.status(500).json({ error: 'Server error.' });
  }
});

// ── DELETE /api/auth/users/:id ────────────────────────────────────────────
router.delete('/users/:id', authenticate, adminOnly, async (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account.' });
  await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
  return res.json({ success: true });
});

module.exports = router;
