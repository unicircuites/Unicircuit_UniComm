/**
 * Canonical phone normalisation — the single source of truth for phone matching.
 * Mirrors the SQL phone_norm() function (created in server.js ensureSchema).
 *
 * Collapses every format to the last 10 digits so these are all EQUAL:
 *   +91XXXXXXXXXX, +91 XXXXXXXXXX, +91 X X X…, +XXXXXXXXXX, XXXXXXXXXX,
 *   X X X…, 0XXXXXXXXXX, 91XXXXXXXXXX, 91 XXXXXXXXXX
 * Short numbers (extensions like 202/390) are returned unchanged.
 */
function normalizePhone(raw) {
  const digits = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (!digits) return '';
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/** True when two phone values refer to the same number, ignoring format. */
function phonesMatch(a, b) {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  return !!na && na === nb;
}

module.exports = { normalizePhone, phonesMatch };
