const pool = require('../db/pool');

function normalizeDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function isAllowedWaNumber(value) {
  const digits = normalizeDigits(value);
  if (!digits || digits.length >= 15 || digits.length < 7) return false;
  return true;
}

function isPhoneLikeText(value, phoneDigits) {
  const text = String(value || '').trim();
  if (!text || text.includes('@lid')) return false;
  const digits = normalizeDigits(text);
  if (!digits) return false;
  if (phoneDigits && digits === phoneDigits) return true;
  if (/^\+?\d[\d\s\-().]+$/.test(text) && digits.length >= 7) return true;
  return false;
}

function formatDisplayPhone(value) {
  const digits = normalizeDigits(value);
  if (!digits) return '';
  if (digits.startsWith('91') && digits.length === 12) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  return `+${digits}`;
}

function pickContactLabel(row, phoneDigits, isGroup) {
  const candidates = isGroup
    ? [row.name, row.chat_name]
    : [row.name, row.notify, row.msg_name, row.crm_name, row.chat_name];
  for (const candidate of candidates) {
    const c = String(candidate || '').trim();
    if (!c) continue;
    if (!isGroup && isPhoneLikeText(c, phoneDigits)) continue;
    if (!isGroup && isAllowedWaNumber(normalizeDigits(c))) continue;
    return c;
  }
  if (isGroup) return 'Group';
  return phoneDigits ? formatDisplayPhone(phoneDigits) : '';
}

async function main() {
  const acc = String(process.argv[2] || '').replace(/\D/g, '');
  if (!acc) {
    console.error('Usage: node backend/scripts/wa_test_labels.js <connected_account_phone>');
    process.exit(1);
  }

  await pool.query(`
    UPDATE wa_contacts wc
    SET notify = src.sender_name, updated_at = NOW()
    FROM (
      SELECT DISTINCT ON (wc2.jid) wc2.jid, m.sender_name
      FROM wa_contacts wc2
      JOIN wa_messages m ON m.account_phone = wc2.account_phone
        AND m.from_me = false AND m.sender_name IS NOT NULL AND m.sender_name != ''
        AND m.sender_name !~ '^\\+?[0-9]'
        AND (m.sender = wc2.jid OR regexp_replace(split_part(COALESCE(m.sender,''), '@', 1), '[^0-9]', '', 'g') = regexp_replace(COALESCE(wc2.phone,''), '[^0-9]', '', 'g'))
      WHERE wc2.account_phone = $1 AND (wc2.notify IS NULL OR wc2.notify = '')
      ORDER BY wc2.jid, m.timestamp DESC
    ) src
    WHERE wc.jid = src.jid AND wc.account_phone = $1
  `, [acc]);

  const rows = await pool.query(`
    WITH enriched_contacts AS (
      SELECT wc.*, msg.sender_name AS msg_name,
        NULLIF(trim(concat(crm.fname, ' ', crm.lname)), '') AS crm_name
      FROM wa_contacts wc
      LEFT JOIN LATERAL (
        SELECT m.sender_name FROM wa_messages m
        WHERE m.account_phone = wc.account_phone AND m.from_me = false
          AND m.sender_name IS NOT NULL AND m.sender_name !~ '^\\+?[0-9]'
          AND (m.sender = wc.jid OR regexp_replace(split_part(COALESCE(m.sender,''), '@', 1), '[^0-9]', '', 'g') = regexp_replace(COALESCE(wc.phone,''), '[^0-9]', '', 'g'))
        ORDER BY m.timestamp DESC LIMIT 1
      ) msg ON true
      LEFT JOIN LATERAL (
        SELECT c.fname, c.lname FROM contacts c
        WHERE regexp_replace(COALESCE(c.phone, c.wa, ''), '[^0-9]', '', 'g') = regexp_replace(COALESCE(wc.phone, ''), '[^0-9]', '', 'g')
           OR right(regexp_replace(COALESCE(c.phone, c.wa, ''), '[^0-9]', '', 'g'), 10) = right(regexp_replace(COALESCE(wc.phone, ''), '[^0-9]', '', 'g'), 10)
        LIMIT 1
      ) crm ON true
      WHERE wc.account_phone = $1
        AND regexp_replace(COALESCE(wc.phone, ''), '[^0-9]', '', 'g') ~ '^[0-9]{7,14}$'
    )
    SELECT * FROM enriched_contacts
  `, [acc]);

  let named = 0;
  let phones = 0;
  const namedSamples = [];
  for (const row of rows.rows) {
    const phoneDigits = normalizeDigits(row.phone);
    const label = pickContactLabel(row, phoneDigits, false);
    if (isPhoneLikeText(label, phoneDigits) || isAllowedWaNumber(normalizeDigits(label))) {
      phones++;
    } else {
      named++;
      if (namedSamples.length < 10) namedSamples.push({ phone: row.phone, label, name: row.name, notify: row.notify, msg: row.msg_name });
    }
  }

  console.log({ total: rows.rowCount, named, phones, namedSamples });
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
