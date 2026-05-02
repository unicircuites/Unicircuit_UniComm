/**
 * EngageBay CRM Service
 * Base URL: https://app.engagebay.com/dev/api/panel/
 * Auth: Authorization header with REST API Key
 */
const https = require('https');
const pool  = require('../db/pool');

const EB_BASE = 'https://app.engagebay.com';
const EB_KEY  = () => process.env.ENGAGEBAY_API_KEY || '';

// ── HTTP HELPER ───────────────────────────────────────────────────────────
function ebRequest(method, path, body, formData) {
  return new Promise((resolve, reject) => {
    const isForm = !!formData;
    const postBody = isForm
      ? formData
      : (body ? JSON.stringify(body) : null);

    const headers = {
      'Authorization': EB_KEY(),
      'Accept': 'application/json',
    };
    if (postBody) {
      headers['Content-Type'] = isForm
        ? 'application/x-www-form-urlencoded'
        : 'application/json';
      headers['Content-Length'] = Buffer.byteLength(postBody);
    }

    const url = new URL(EB_BASE + path);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: data ? JSON.parse(data) : {} });
        } catch (_) {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });
    req.on('error', reject);
    if (postBody) req.write(postBody);
    req.end();
  });
}

// ── CONTACTS ──────────────────────────────────────────────────────────────
async function getContacts(pageSize = 50, cursor = null) {
  let body = `page_size=${pageSize}&sort_key=-created_time`;
  if (cursor) body += `&cursor=${encodeURIComponent(cursor)}`;
  const r = await ebRequest('POST', '/dev/api/panel/subscribers', null, body);
  return r.data;
}

async function searchContacts(q, pageSize = 20) {
  const r = await ebRequest('GET', `/dev/api/search?q=${encodeURIComponent(q)}&type=Subscriber&page_size=${pageSize}`);
  return r.data;
}

async function createContact(contact) {
  const r = await ebRequest('POST', '/dev/api/panel/subscribers/subscriber', contact);
  return r.data;
}

async function getContactByEmail(email) {
  const r = await ebRequest('GET', `/dev/api/panel/subscribers/contact-by-email/${encodeURIComponent(email)}`);
  return r.data;
}

// ── DEALS ─────────────────────────────────────────────────────────────────
async function getDeals(pageSize = 50) {
  const r = await ebRequest('POST', '/dev/api/panel/deals', null, `page_size=${pageSize}&sort_key=-created_time`);
  return r.data;
}

async function createDeal(deal) {
  const r = await ebRequest('POST', '/dev/api/panel/deals/deal', deal);
  return r.data;
}

// ── LISTS ─────────────────────────────────────────────────────────────────
async function getLists() {
  const r = await ebRequest('GET', '/dev/api/panel/contactlist');
  return r.data;
}

// ── TAGS ──────────────────────────────────────────────────────────────────
async function getTags() {
  const r = await ebRequest('GET', '/dev/api/panel/tags');
  return r.data;
}

// ── BROADCAST ─────────────────────────────────────────────────────────────
async function sendBroadcast(emailIds, templateId, fromEmail) {
  const r = await ebRequest('POST', '/dev/api/panel/bulk-actions/broadcast', {
    emailIds, template_id: templateId, from_email: fromEmail
  });
  return r.data;
}

// ── TASKS ─────────────────────────────────────────────────────────────────
async function getTasks(status = 'not_started', pageSize = 20) {
  const r = await ebRequest('POST', '/dev/api/panel/tasks', null,
    `taskStatus=${status}&taskType=ALL&page_size=${pageSize}&sort_key=-created_time`);
  return r.data;
}

// ── HELPER: parse contact properties ─────────────────────────────────────
function parseContact(c) {
  const props = {};
  (c.properties || []).forEach(p => { props[p.name] = p.value; });
  return {
    id:       c.id,
    name:     props.name || c.name || '',
    lastName: props.last_name || '',
    email:    props.email || c.email || '',
    phone:    props.phone || '',
    company:  props.company || '',
    score:    c.score || 0,
    tags:     (c.tags || []).map(t => t.tag || t),
    status:   c.status || '',
    created:  c.created_time,
    updated:  c.updated_time,
  };
}

module.exports = {
  getContacts, searchContacts, createContact, getContactByEmail,
  getDeals, createDeal,
  getLists, getTags,
  sendBroadcast, getTasks,
  parseContact,
};
