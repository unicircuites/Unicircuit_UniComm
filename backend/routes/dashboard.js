const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

async function safeQuery(sql, params = []) {
  try {
    return await pool.query(sql, params);
  } catch (err) {
    console.warn('[Dashboard] Query skipped:', err.message);
    return { rows: [] };
  }
}

async function countSyncedEmails() {
  try {
    const r = await pool.query('SELECT COUNT(*)::int AS total FROM outlook_emails_cache');
    return parseInt(r.rows[0].total || 0, 10);
  } catch (_) {
    const r = await safeQuery('SELECT COALESCE(SUM(emails_count), 0)::int AS total FROM contacts');
    return parseInt(r.rows[0]?.total || 0, 10);
  }
}

async function countWaChats() {
  const r = await safeQuery(`
    SELECT COUNT(*)::int AS total,
           COALESCE(SUM(unread), 0)::int AS unread
    FROM wa_chats
  `);
  return {
    total: parseInt(r.rows[0]?.total || 0, 10),
    unread: parseInt(r.rows[0]?.unread || 0, 10),
  };
}

// GET /api/dashboard/stats
router.get('/stats', async (req, res) => {
  try {
    const [
      contacts,
      calls,
      calls7d,
      callsToday,
      waChats,
      campaigns,
      pipeline,
      emailsSynced,
    ] = await Promise.all([
      safeQuery(`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS new_week
        FROM contacts
      `),
      safeQuery(`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE call_type = 'Missed')::int AS missed
        FROM call_logs
      `),
      safeQuery(`
        SELECT COUNT(*)::int AS total
        FROM call_logs
        WHERE created_at >= NOW() - INTERVAL '7 days'
      `),
      safeQuery(`
        SELECT COUNT(*)::int AS total
        FROM call_logs
        WHERE created_at >= CURRENT_DATE
      `),
      countWaChats(),
      safeQuery(`SELECT COUNT(*)::int AS active FROM campaigns WHERE status IN ('Active','Live')`),
      safeQuery(`
        SELECT COUNT(*)::int AS deals,
               COUNT(*) FILTER (WHERE stage = 'Won')::int AS won,
               COUNT(*) FILTER (WHERE stage NOT IN ('Won', 'Lost'))::int AS open,
               COALESCE(SUM(
                 CASE WHEN value ~ '^[0-9]+(\\.[0-9]+)?$' THEN value::numeric ELSE 0 END
               ), 0) AS total_value
        FROM pipeline_deals
      `),
      countSyncedEmails(),
    ]);

    return res.json({
      calls_7d: { total: parseInt(calls7d.rows[0]?.total || 0, 10) },
      calls_today: { total: parseInt(callsToday.rows[0]?.total || 0, 10) },
      emails_synced: { total: emailsSynced },
      wa_chats: { total: waChats.total, unread: waChats.unread },
      contacts: {
        total: parseInt(contacts.rows[0]?.total || 0, 10),
        new_today: parseInt(contacts.rows[0]?.new_week || 0, 10),
      },
      calls: {
        total: parseInt(calls.rows[0]?.total || 0, 10),
        missed: parseInt(calls.rows[0]?.missed || 0, 10),
      },
      campaigns: { active: parseInt(campaigns.rows[0]?.active || 0, 10) },
      pipeline: {
        deals: parseInt(pipeline.rows[0]?.deals || 0, 10),
        won: parseInt(pipeline.rows[0]?.won || 0, 10),
        open: parseInt(pipeline.rows[0]?.open || 0, 10),
        total_value: parseFloat(pipeline.rows[0]?.total_value || 0),
      },
    });
  } catch (err) {
    console.error('[Dashboard] Stats error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch stats.' });
  }
});

// GET /api/dashboard/overview
router.get('/overview', async (req, res) => {
  try {
    const liveCallsRes = await safeQuery(`
      SELECT
        cl.id,
        cl.caller,
        cl.destination,
        cl.duration,
        cl.call_type,
        cl.ai_summary,
        COALESCE(NULLIF(trim(c.fname || ' ' || c.lname), ''), cl.caller, 'Unknown') AS contact_name
      FROM call_logs cl
      LEFT JOIN contacts c ON (
        regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') = regexp_replace(COALESCE(cl.caller, ''), '[^0-9]', '', 'g')
        OR regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') = regexp_replace(COALESCE(cl.destination, ''), '[^0-9]', '', 'g')
      )
      WHERE NOT (cl.duration IS NULL OR cl.duration = '' OR cl.duration = '00:00:00')
      ORDER BY COALESCE(cl.call_date::timestamp + COALESCE(cl.call_time, TIME '00:00:00'), cl.created_at) DESC
      LIMIT 5
    `);

    const topContactsRes = await safeQuery(`
      WITH recent_calls AS (
        SELECT regexp_replace(COALESCE(destination, caller, ''), '[^0-9]', '', 'g') AS phone_digits
        FROM call_logs
        WHERE created_at >= NOW() - INTERVAL '1 day'
          AND COALESCE(destination, caller) IS NOT NULL
      )
      SELECT
        rc.phone_digits,
        COUNT(*)::int AS interactions,
        COALESCE(
          NULLIF(trim(c.fname || ' ' || c.lname), ''),
          NULLIF(c.company, ''),
          'Contact ' || right(rc.phone_digits, 4)
        ) AS name
      FROM recent_calls rc
      LEFT JOIN contacts c ON regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') = rc.phone_digits
      WHERE rc.phone_digits <> ''
      GROUP BY rc.phone_digits, c.fname, c.lname, c.company
      ORDER BY interactions DESC, name ASC
      LIMIT 3
    `);

    const activityRes = await safeQuery(`
      SELECT
        (SELECT COUNT(*)::int FROM call_logs WHERE created_at >= NOW() - INTERVAL '7 days') AS calls,
        (SELECT COUNT(*)::int FROM wa_messages WHERE timestamp >= NOW() - INTERVAL '7 days') AS whatsapp,
        (SELECT COUNT(*)::int FROM outlook_emails_cache) AS email
    `);

    const pipelineRes = await safeQuery(`
      SELECT
        COALESCE(SUM(CASE WHEN value ~ '^[0-9]+(\\.[0-9]+)?$' THEN value::numeric ELSE 0 END), 0) AS total_value,
        COALESCE(SUM(CASE WHEN stage = 'Won' AND value ~ '^[0-9]+(\\.[0-9]+)?$' THEN value::numeric ELSE 0 END), 0) AS won_value,
        COALESCE(SUM(CASE WHEN stage NOT IN ('Won', 'Lost') AND value ~ '^[0-9]+(\\.[0-9]+)?$' THEN value::numeric ELSE 0 END), 0) AS open_value
      FROM pipeline_deals
    `);

    let latestWaThread = { chat_name: null, messages: [] };
    const waThreadQ = await safeQuery(`
      WITH latest_chat AS (
        SELECT id, name, account_phone
        FROM wa_chats
        ORDER BY COALESCE(last_time, updated_at) DESC NULLS LAST
        LIMIT 1
      )
      SELECT lc.name AS chat_name, m.body, m.timestamp, m.from_me
      FROM latest_chat lc
      LEFT JOIN LATERAL (
        SELECT body, timestamp, from_me
        FROM wa_messages
        WHERE chat_id = lc.id AND account_phone = lc.account_phone
        ORDER BY timestamp DESC NULLS LAST
        LIMIT 3
      ) m ON true
      ORDER BY m.timestamp ASC NULLS LAST
    `);
    if (waThreadQ.rows.length) {
      latestWaThread = {
        chat_name: waThreadQ.rows[0].chat_name || null,
        messages: waThreadQ.rows
          .filter((r) => r.body)
          .map((r) => ({ body: r.body, timestamp: r.timestamp, from_me: !!r.from_me })),
      };
    }

    const act = activityRes.rows[0] || {};
    const callsAct = parseInt(act.calls || 0, 10);
    const waAct = parseInt(act.whatsapp || 0, 10);
    const emailAct = parseInt(act.email || 0, 10);
    const pipe = pipelineRes.rows[0] || {};

    return res.json({
      live_calls: liveCallsRes.rows || [],
      top_contacts: topContactsRes.rows || [],
      activity_mix: {
        total: callsAct + waAct + emailAct,
        email: emailAct,
        whatsapp: waAct,
        calls: callsAct,
      },
      pipeline_value: {
        total: parseFloat(pipe.total_value || 0),
        won: parseFloat(pipe.won_value || 0),
        open: parseFloat(pipe.open_value || 0),
      },
      latest_wa_thread: latestWaThread,
    });
  } catch (err) {
    console.error('[Dashboard] Overview error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch dashboard overview.' });
  }
});

module.exports = router;
