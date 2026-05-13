const jwt = require('jsonwebtoken');

// Store last activity time for each user session
const sessionActivity = new Map();

// Idle timeout in milliseconds (default: 30 minutes)
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS, 10) || (30 * 60 * 1000);

/**
 * Verifies JWT from Authorization: Bearer <token> header.
 * Attaches decoded payload to req.user.
 * Implements idle timeout - sessions expire after 30 minutes of inactivity.
 */
function authenticate(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  const token = header.slice(7);
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'unicomm_secret');
    
    // Check idle timeout
    const sessionKey = `${decoded.id}_${decoded.email}`;
    const lastActivity = sessionActivity.get(sessionKey);
    const now = Date.now();
    
    if (lastActivity && (now - lastActivity) > IDLE_TIMEOUT_MS) {
      // Session expired due to inactivity
      sessionActivity.delete(sessionKey);
      return res.status(401).json({ 
        error: 'Session expired due to inactivity. Please log in again.',
        reason: 'idle_timeout'
      });
    }
    
    // Update last activity time
    sessionActivity.set(sessionKey, now);
    
    req.user = decoded;
    next();
  } catch (_) {
    return res.status(401).json({ error: 'Invalid or expired token. Please log in again.' });
  }
}

/** Requires admin role. */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

/**
 * Clears session activity for a user (called on logout).
 */
function clearSession(userId, email) {
  const sessionKey = `${userId}_${email}`;
  sessionActivity.delete(sessionKey);
}

module.exports = { authenticate, requireAdmin, clearSession };
