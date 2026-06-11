const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const wa = require('../services/whatsapp');

const router = express.Router();
router.use(authenticate);

async function safeQuery(sql, params = []) {
  try {
    return await pool.query(sql, params);
  } catch (err) {
    console.error('[Dashboard] Query failed:', err.message, '| SQL:', sql.slice(0, 120));
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
  const accountPhone = wa.getConnectedPhone();
  if (!accountPhone) return { total: 0, unread: 0 };
  const r = await safeQuery(`
    SELECT COUNT(*)::int AS total,
           COALESCE(SUM(unread), 0)::int AS unread
    FROM wa_chats
    WHERE account_phone = $1
  `, [accountPhone]);
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
    const waAccountPhone = wa.getConnectedPhone();
    const liveCallsRes = await safeQuery(`
      SELECT
        cl.id,
        cl.caller,
        cl.destination,
        cl.duration,
        cl.call_type,
        cl.ai_summary,
        cl.recording_file,
        TO_CHAR(cl.call_date, 'YYYY-MM-DD') AS call_date,
        cl.call_time,
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
        (SELECT COUNT(*)::int FROM wa_messages WHERE timestamp >= NOW() - INTERVAL '7 days' AND account_phone = $1) AS whatsapp,
        (SELECT COUNT(*)::int FROM outlook_emails_cache) AS email
    `, [waAccountPhone || '__no_connected_wa__']);

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
        WHERE account_phone = $1
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
    `, [waAccountPhone || '__no_connected_wa__']);
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


// GET /api/dashboard/insights?period=day|week|month|year&from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/insights', async (req, res) => {
  try {
    const { period = 'week', from, to } = req.query;
    const waAccountPhone = wa.getConnectedPhone() || await (async () => {
      try {
        const r = await pool.query(`SELECT account_phone FROM wa_chats GROUP BY account_phone ORDER BY COUNT(*) DESC LIMIT 1`);
        return r.rows[0]?.account_phone || null;
      } catch { return null; }
    })();

    // Build period interval
    let intervalSql;
    let fromTs, toTs;
    if (from && to) {
      fromTs = new Date(from); toTs = new Date(to); toTs.setHours(23,59,59,999);
      intervalSql = `created_at BETWEEN '${fromTs.toISOString()}' AND '${toTs.toISOString()}'`;
    } else {
      const map = { day: '1 day', week: '7 days', month: '30 days', year: '365 days' };
      const iv = map[period] || '7 days';
      intervalSql = `created_at >= NOW() - INTERVAL '${iv}'`;
    }

    // call_date-based interval for call_logs (which use call_date not created_at)
    let callIntervalSql;
    if (from && to) {
      callIntervalSql = `call_date BETWEEN '${new Date(from).toISOString().slice(0,10)}' AND '${new Date(to).toISOString().slice(0,10)}'`;
    } else {
      const map = { day: '1 day', week: '7 days', month: '30 days', year: '365 days' };
      callIntervalSql = `call_date >= (NOW() - INTERVAL '${map[period] || '7 days'}')::date`;
    }

    const [
      waUnread,
      waContacts,
      waLabels,
      callStats,
      newCalls,
      auditActivity,
      todayCalls,
      yesterdayCalls,
      todayWaUnread,
      yesterdayActivity,
    ] = await Promise.all([
      // WA unread chats list
      waAccountPhone ? safeQuery(`
        SELECT id AS jid, name, unread, last_message, last_time
        FROM wa_chats
        WHERE account_phone = $1 AND unread > 0
        ORDER BY last_time DESC NULLS LAST
        LIMIT 20
      `, [waAccountPhone]) : Promise.resolve({ rows: [] }),

      // WA contacts breakdown
      waAccountPhone ? safeQuery(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE jid LIKE '%@g.us')::int AS groups,
          COUNT(*) FILTER (WHERE jid LIKE '%@newsletter')::int AS announcements,
          COUNT(*) FILTER (WHERE jid NOT LIKE '%@g.us' AND jid NOT LIKE '%@newsletter')::int AS individual,
          (SELECT COUNT(*)::int FROM wa_contacts
           WHERE account_phone = $1 AND (is_business = true OR verified_name IS NOT NULL)) AS business
        FROM wa_chats WHERE account_phone = $1
      `, [waAccountPhone]) : Promise.resolve({ rows: [{ total:0, groups:0, announcements:0, individual:0, business:0 }] }),

      // WA labels with chat count
      waAccountPhone ? safeQuery(`
        SELECT l.id, l.name, l.color, COUNT(a.chat_id)::int AS chat_count
        FROM wa_labels l
        LEFT JOIN wa_label_associations a ON a.label_id = l.id AND a.account_phone = l.account_phone
        WHERE l.account_phone = $1
        GROUP BY l.id, l.name, l.color, l.account_phone
        ORDER BY chat_count DESC
      `, [waAccountPhone]) : Promise.resolve({ rows: [] }),

      // Call log breakdown
      safeQuery(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE call_type = 'Missed')::int AS missed,
          COUNT(*) FILTER (WHERE call_type = 'In')::int AS attended_in,
          COUNT(*) FILTER (WHERE call_type = 'Out')::int AS attended_out,
          COUNT(*) FILTER (WHERE call_type NOT IN ('Missed') AND (duration IS NULL OR duration = '' OR duration = '00:00:00'))::int AS unattended,
          COUNT(*) FILTER (WHERE recording_file IS NOT NULL AND recording_file != '' AND recording_file ~* '\\.(wav|mp3|ogg|m4a)$')::int AS recording_captured,
          COUNT(*) FILTER (WHERE recording_file IS NULL OR recording_file = '' OR recording_file !~* '\\.(wav|mp3|ogg|m4a)$')::int AS recording_missing
        FROM call_logs WHERE ${callIntervalSql}
      `),

      // New calls in period (with details)
      safeQuery(`
        SELECT cl.id, cl.caller, cl.destination, cl.call_type, cl.duration,
               TO_CHAR(cl.call_date,'YYYY-MM-DD') AS call_date, cl.call_time,
               cl.recording_file,
               pc.name AS contact_name
        FROM call_logs cl
        LEFT JOIN pbx_contacts pc ON pc.name IS NOT NULL
          AND regexp_replace(pc.phone,'[^0-9]','','g') = regexp_replace(cl.caller,'[^0-9]','','g')
        WHERE ${callIntervalSql}
        ORDER BY cl.call_date DESC NULLS LAST, cl.call_time DESC NULLS LAST, cl.id DESC
        LIMIT 20
      `),

      // User activity from audit_log
      safeQuery(`
        SELECT al.id, al.action, al.entity, al.entity_id, al.detail,
               al.created_at, u.name AS user_name, u.email AS user_email
        FROM audit_log al
        LEFT JOIN users u ON u.id = al.user_id
        WHERE al.created_at >= NOW() - INTERVAL '${
          from && to ? '9999 days' :
          ({ day: '1 day', week: '7 days', month: '30 days', year: '365 days' }[period] || '7 days')
        }'${from && to ? ` AND al.created_at BETWEEN '${new Date(from).toISOString()}' AND '${toTs.toISOString()}'` : ''}
        ORDER BY al.created_at DESC
        LIMIT 100
      `),

      // Comparison queries — merged into same Promise.all to avoid serial wait
      safeQuery(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE call_type='Missed')::int AS missed FROM call_logs WHERE call_date = CURRENT_DATE`),
      safeQuery(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE call_type='Missed')::int AS missed FROM call_logs WHERE call_date = CURRENT_DATE - 1`),
      waAccountPhone ? safeQuery(`SELECT COALESCE(SUM(unread),0)::int AS unread FROM wa_chats WHERE account_phone=$1`, [waAccountPhone]) : Promise.resolve({ rows:[{unread:0}] }),
      safeQuery(`SELECT COUNT(*)::int AS total FROM audit_log WHERE created_at >= CURRENT_DATE - 1 AND created_at < CURRENT_DATE`),
    ]);

    const todayCs  = todayCalls.rows[0]     || { total:0, missed:0 };
    const yestCs   = yesterdayCalls.rows[0] || { total:0, missed:0 };

    const cs = callStats.rows[0] || {};
    return res.json({
      period,
      wa_unread: waUnread.rows,
      wa_contacts: waContacts.rows[0] || { total:0, groups:0, announcements:0, individual:0, business:0 },
      wa_labels: waLabels.rows,
      call_stats: {
        total:               parseInt(cs.total || 0),
        missed:              parseInt(cs.missed || 0),
        attended_in:         parseInt(cs.attended_in || 0),
        attended_out:        parseInt(cs.attended_out || 0),
        unattended:          parseInt(cs.unattended || 0),
        recording_captured:  parseInt(cs.recording_captured || 0),
        recording_missing:   parseInt(cs.recording_missing || 0),
      },
      comparison: {
        today:     { calls: parseInt(todayCs.total||0), missed: parseInt(todayCs.missed||0), wa_unread: parseInt(todayWaUnread.rows[0]?.unread||0) },
        yesterday: { calls: parseInt(yestCs.total||0),  missed: parseInt(yestCs.missed||0),  activity:  parseInt(yesterdayActivity.rows[0]?.total||0) },
      },
      recent_calls: newCalls.rows,
      user_activity: auditActivity.rows,
    });
  } catch (err) {
    console.error('[Dashboard] Insights error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
