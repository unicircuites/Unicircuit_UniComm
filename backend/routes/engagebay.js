/**
 * EngageBay CRM Routes
 * All proxied through backend to keep API key secure
 */
const express = require('express');
const eb      = require('../services/engagebay');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// GET /api/eb/contacts?q=search&page=50&cursor=xxx
router.get('/contacts', async (req, res) => {
  try {
    const { q, page_size, cursor } = req.query;
    let data;
    if (q) {
      data = await eb.searchContacts(q, parseInt(page_size || 20));
    } else {
      data = await eb.getContacts(parseInt(page_size || 50), cursor || null);
    }
    const contacts = Array.isArray(data) ? data.map(eb.parseContact) : [];
    res.json({ contacts, cursor: contacts.length ? (contacts[contacts.length-1].cursor || null) : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/eb/contacts/email/:email
router.get('/contacts/email/:email', async (req, res) => {
  try {
    const data = await eb.getContactByEmail(req.params.email);
    const contacts = Array.isArray(data) ? data.map(eb.parseContact) : [];
    res.json(contacts[0] || null);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/eb/contacts
router.post('/contacts', async (req, res) => {
  try {
    const { name, email, phone, company, tags } = req.body;
    const contact = {
      properties: [
        { name: 'name',  value: name  || '', field_type: 'TEXT', type: 'SYSTEM' },
        { name: 'email', value: email || '', field_type: 'TEXT', type: 'SYSTEM' },
        { name: 'phone', value: phone || '', field_type: 'TEXT', type: 'SYSTEM' },
      ],
      tags: (tags || []).map(t => ({ tag: t })),
    };
    const data = await eb.createContact(contact);
    res.json(eb.parseContact(data));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/eb/deals
router.get('/deals', async (req, res) => {
  try {
    const data = await eb.getDeals(parseInt(req.query.page_size || 50));
    res.json(Array.isArray(data) ? data : []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/eb/deals
router.post('/deals', async (req, res) => {
  try {
    const data = await eb.createDeal(req.body);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/eb/lists
router.get('/lists', async (req, res) => {
  try { res.json(await eb.getLists()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/eb/tags
router.get('/tags', async (req, res) => {
  try { res.json(await eb.getTags()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/eb/tasks
router.get('/tasks', async (req, res) => {
  try {
    const data = await eb.getTasks(req.query.status || 'not_started', parseInt(req.query.page_size || 20));
    res.json(Array.isArray(data) ? data : []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/eb/broadcast
router.post('/broadcast', async (req, res) => {
  try {
    const { emailIds, template_id, from_email } = req.body;
    if (!emailIds?.length || !template_id || !from_email)
      return res.status(400).json({ error: 'emailIds, template_id, from_email required' });
    const data = await eb.sendBroadcast(emailIds, template_id, from_email);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
