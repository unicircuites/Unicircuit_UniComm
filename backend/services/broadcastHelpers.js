'use strict';

const activeEmailBroadcastJobs = new Set();
const activeWaBroadcastJobs = new Set();

function parseJsonField(value, fallback) {
  if (value == null) return fallback;
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed == null ? fallback : parsed;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function buildUndeliveredEmailRecipients(recipients, deliveries) {
  const statusByEmail = new Map(
    (deliveries || []).map((d) => [String(d.email || '').toLowerCase(), String(d.status || '').toLowerCase()])
  );
  const out = [];
  const seen = new Set();
  for (const r of recipients || []) {
    const email = String(typeof r === 'string' ? r : r.email || '').trim();
    if (!email || !email.includes('@')) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (statusByEmail.get(key) === 'sent') continue;
    out.push(typeof r === 'object' ? { ...r, email } : { email, name: '' });
  }
  return out;
}

function buildUndeliveredWaRecipients(recipients, deliveries) {
  const statusByJid = new Map(
    (deliveries || []).map((d) => [String(d.jid || '').toLowerCase(), String(d.status || '').toLowerCase()])
  );
  const out = [];
  const seen = new Set();
  for (const r of recipients || []) {
    const jid = String(typeof r === 'string' ? r : r.jid || '').trim();
    if (!jid || !jid.includes('@')) continue;
    const key = jid.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (statusByJid.get(key) === 'sent') continue;
    out.push(typeof r === 'object' ? { ...r, jid } : { jid, name: '' });
  }
  return out;
}

function mergeEmailDeliveries(baseDeliveries, batchDeliveries) {
  const updates = new Map(
    (batchDeliveries || []).map((d) => [String(d.email || '').toLowerCase(), d])
  );
  return (baseDeliveries || []).map((d) => updates.get(String(d.email || '').toLowerCase()) || d);
}

function mergeWaDeliveries(baseDeliveries, batchDeliveries) {
  const updates = new Map(
    (batchDeliveries || []).map((d) => [String(d.jid || '').toLowerCase(), d])
  );
  return (baseDeliveries || []).map((d) => updates.get(String(d.jid || '').toLowerCase()) || d);
}

function tallyDeliveries(deliveries) {
  let sent = 0;
  let failed = 0;
  for (const d of deliveries || []) {
    if (d.status === 'sent') sent += 1;
    else if (d.status === 'failed') failed += 1;
  }
  return { sent, failed };
}

function finalBroadcastStatus(deliveries, total) {
  const { sent, failed } = tallyDeliveries(deliveries);
  const pending = Math.max(0, total - sent - failed);
  if (pending > 0) return 'partial';
  if (sent === 0 && failed > 0) return 'failed';
  if (failed > 0) return 'partial';
  return 'sent';
}

function acquireEmailBroadcastJob(id) {
  const key = String(id);
  if (activeEmailBroadcastJobs.has(key)) return false;
  activeEmailBroadcastJobs.add(key);
  return true;
}

function releaseEmailBroadcastJob(id) {
  activeEmailBroadcastJobs.delete(String(id));
}

function acquireWaBroadcastJob(id) {
  const key = String(id);
  if (activeWaBroadcastJobs.has(key)) return false;
  activeWaBroadcastJobs.add(key);
  return true;
}

function releaseWaBroadcastJob(id) {
  activeWaBroadcastJobs.delete(String(id));
}

module.exports = {
  parseJsonField,
  buildUndeliveredEmailRecipients,
  buildUndeliveredWaRecipients,
  mergeEmailDeliveries,
  mergeWaDeliveries,
  tallyDeliveries,
  finalBroadcastStatus,
  acquireEmailBroadcastJob,
  releaseEmailBroadcastJob,
  acquireWaBroadcastJob,
  releaseWaBroadcastJob,
};
