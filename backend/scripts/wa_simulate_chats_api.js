const pool = require('../db/pool');

function normalizeDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function isAllowedWaNumber(value) {
  const digits = normalizeDigits(value);
  if (!digits) return false;
  if (digits.length >= 15) return false;
  if (digits.length < 7) return false;
  if (/^0{5,}$/.test(digits)) return false;
  return true;
}

function isPhoneLikeText(value, phoneDigits) {
  const text = String(value || '').trim();
  if (!text) return false;
  const digits = normalizeDigits(text);
  if (phoneDigits && digits === phoneDigits) return true;
  if (/^\+?\d[\d\s\-().]+$/.test(text) && digits.length >= 7) return true;
  return false;
}

function pickContactLabel(row, phoneDigits, isGroup) {
  const name = String(row.name || '').trim();
  const notify = String(row.notify || '').trim();
  if (isGroup) {
    if (name && !/^\d+$/.test(name)) return name;
    return 'Group';
  }
  if (notify && !isPhoneLikeText(notify, phoneDigits) && !notify.includes('@lid')) return notify;
  if (name && !isPhoneLikeText(name, phoneDigits) && !name.includes('@lid') && !isAllowedWaNumber(normalizeDigits(name))) return name;
  return '';
}

async function main() {
  const accountPhone = String(process.argv[2] || '').replace(/\D/g, '');
  if (!accountPhone) {
    console.error('Usage: node backend/scripts/wa_simulate_chats_api.js <connected_account_phone>');
    process.exit(1);
  }
  const result = await pool.query(`
      WITH chat_rows AS (
        SELECT
          c.id,
          c.account_phone,
          COALESCE(c.name, wc.name, wc.notify) AS name,
          wc.notify,
          COALESCE(c.phone, wc.phone) AS phone,
          c.is_group,
          COALESCE(wc.is_group_member, false) AS is_group_member,
          COALESCE(NULLIF(latest.body, ''), NULLIF(c.last_message, ''), c.last_message) AS last_message,
          COALESCE(latest.timestamp, c.last_time) AS last_time,
          c.unread,
          c.updated_at,
          0 AS sort_bucket
        FROM wa_chats c
        LEFT JOIN LATERAL (
          SELECT body, timestamp
          FROM wa_messages m
          WHERE m.chat_id = c.id AND m.account_phone = c.account_phone
          ORDER BY m.timestamp DESC NULLS LAST
          LIMIT 1
        ) latest ON true
        LEFT JOIN wa_contacts wc ON wc.jid = c.id AND wc.account_phone = c.account_phone
        WHERE c.account_phone = $1
          AND c.id NOT LIKE '%@newsletter'
          AND c.id NOT LIKE '%@broadcast'
          AND c.id <> 'status@broadcast'
      ),
      contact_rows AS (
        SELECT
          regexp_replace(wc.phone, '[^0-9]', '', 'g') || '@s.whatsapp.net' AS id,
          wc.account_phone,
          COALESCE(NULLIF(wc.name, ''), NULLIF(wc.notify, '')) AS name,
          wc.notify,
          regexp_replace(COALESCE(wc.phone, ''), '[^0-9]', '', 'g') AS phone,
          false AS is_group,
          false AS is_group_member,
          '' AS last_message,
          NULL::timestamptz AS last_time,
          0 AS unread,
          wc.updated_at,
          1 AS sort_bucket
        FROM wa_contacts wc
        WHERE wc.account_phone = $1
          AND regexp_replace(COALESCE(wc.phone, ''), '[^0-9]', '', 'g') ~ '^[0-9]{7,14}$'
          AND regexp_replace(COALESCE(wc.phone, ''), '[^0-9]', '', 'g') <> split_part(wc.jid, '@', 1)
      ),
      combined AS (
        SELECT * FROM chat_rows
        UNION ALL
        SELECT * FROM contact_rows
      )
      SELECT DISTINCT ON (account_phone, id) *
      FROM combined
      ORDER BY account_phone, id, sort_bucket ASC, last_time DESC NULLS LAST, updated_at DESC NULLS LAST
  `, [accountPhone]);

  let kept = 0;
  let dropped = 0;
  let lidKept = 0;
  let phoneOnly = 0;
  let named = 0;
  const droppedSamples = [];

  for (const row of result.rows) {
    const id = String(row.id);
    const isGroup = id.endsWith('@g.us');
    const idLocal = id.split('@')[0];
    const rawPhoneDigits = normalizeDigits(row.phone || (id.endsWith('@lid') ? '' : idLocal));
    const phoneDigits = id.endsWith('@lid') && rawPhoneDigits === idLocal ? '' : rawPhoneDigits;
    const allowedNumber = isAllowedWaNumber(phoneDigits);
    const label = pickContactLabel(row, phoneDigits, isGroup);
    const hasNamedLidFallback = !isGroup && id.endsWith('@lid') && !phoneDigits && !!label;

    if (!isGroup && id.endsWith('@lid') && !phoneDigits && !hasNamedLidFallback) {
      dropped++;
      if (droppedSamples.length < 5) droppedSamples.push({ id, name: row.name, notify: row.notify });
      continue;
    }
    if (!isGroup && !allowedNumber && !hasNamedLidFallback) {
      dropped++;
      if (droppedSamples.length < 5) droppedSamples.push({ id, name: row.name, phone: row.phone });
      continue;
    }
    if (!isGroup && id.includes('@lid') && !hasNamedLidFallback) {
      dropped++;
      continue;
    }
    kept++;
    if (id.endsWith('@lid')) lidKept++;
    if (label) named++; else phoneOnly++;
  }

  console.log({
    accountPhone,
    rawRows: result.rowCount,
    kept,
    dropped,
    lidKept,
    named,
    phoneOnly,
    droppedSamples,
  });

  const notifyStats = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE NULLIF(notify,'') IS NOT NULL)::int AS with_notify,
      COUNT(*) FILTER (WHERE NULLIF(name,'') IS NOT NULL AND name !~ '^\\+?[0-9]' AND length(regexp_replace(name,'[^0-9]','','g')) < 10)::int AS with_real_name
    FROM wa_contacts WHERE account_phone=$1
      AND regexp_replace(COALESCE(phone,''),'[^0-9]','','g') ~ '^[0-9]{7,14}$'
      AND regexp_replace(COALESCE(phone,''),'[^0-9]','','g') <> split_part(jid,'@',1)
  `, [accountPhone]);
  console.log('contact name stats', notifyStats.rows[0]);

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
