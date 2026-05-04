/**
 * Database initialisation + seed script
 * Run once:  node db/init.js
 *
 * Auto-creates the database if it does not exist, then creates
 * all tables and seeds demo data.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');

const DB_NAME = process.env.DB_NAME || 'unicomm_db';

// ── Step 1: connect to the default 'postgres' database to create our DB ──
async function ensureDatabase() {
  const adminPool = new Pool({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432'),
    database: 'postgres',                   // always exists
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || '',
    connectionTimeoutMillis: 5000,
  });

  const client = await adminPool.connect();
  try {
    const res = await client.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`, [DB_NAME]
    );
    if (res.rowCount === 0) {
      // identifiers cannot be parameterised — DB_NAME is from our own .env
      await client.query(`CREATE DATABASE "${DB_NAME}"`);
      console.log(`✅  Database "${DB_NAME}" created.`);
    } else {
      console.log(`ℹ️   Database "${DB_NAME}" already exists.`);
    }
  } finally {
    client.release();
    await adminPool.end();
  }
}

// ── Step 2: connect to our DB and set up schema + seed ───────────────────
const pool = require('./pool');

async function init() {
  // First make sure the database exists
  await ensureDatabase();

  const client = await pool.connect();
  try {
    console.log('\n🔧  Initialising UniComm Pro database…\n');

    // ── USERS ──────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id               SERIAL PRIMARY KEY,
        name             VARCHAR(120) NOT NULL,
        email            VARCHAR(200) UNIQUE NOT NULL,
        password         VARCHAR(255) NOT NULL,
        role             VARCHAR(50)  NOT NULL DEFAULT 'user',
        avatar_initials  VARCHAR(4),
        is_active        BOOLEAN NOT NULL DEFAULT TRUE,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_login       TIMESTAMPTZ
      );
    `);

    // ── CONTACTS ───────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        id            SERIAL PRIMARY KEY,
        fname         VARCHAR(80)  NOT NULL,
        lname         VARCHAR(80)  NOT NULL,
        company       VARCHAR(150) NOT NULL,
        designation   VARCHAR(120),
        dept          VARCHAR(100),
        phone         VARCHAR(30),
        wa            VARCHAR(30),
        email         VARCHAR(200),
        segment       VARCHAR(50)  DEFAULT 'Prospect',
        score         SMALLINT     DEFAULT 50 CHECK (score BETWEEN 0 AND 100),
        products      TEXT,
        city          VARCHAR(80),
        notes         TEXT,
        avatar_color  VARCHAR(30),
        avatar_bg     VARCHAR(60),
        initials      VARCHAR(4),
        calls         INT DEFAULT 0,
        emails_count  INT DEFAULT 0,
        wa_count      INT DEFAULT 0,
        last_contact  VARCHAR(40),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ── PIPELINE DEALS ─────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS pipeline_deals (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(200) NOT NULL,
        company     VARCHAR(150),
        value       VARCHAR(30),
        stage       VARCHAR(60)  DEFAULT 'Prospect',
        score       SMALLINT     DEFAULT 50,
        owner       VARCHAR(80),
        due_date    VARCHAR(30),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ── CALL LOGS ──────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS call_logs (
        id          SERIAL PRIMARY KEY,
        caller      VARCHAR(120),
        extension   VARCHAR(20),
        destination VARCHAR(120),
        duration    VARCHAR(20),
        call_type   VARCHAR(20),
        ai_summary  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ── CAMPAIGNS ──────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id           SERIAL PRIMARY KEY,
        name         VARCHAR(200) NOT NULL,
        product      VARCHAR(200),
        segment      VARCHAR(80),
        channel      VARCHAR(50),
        status       VARCHAR(30)  DEFAULT 'Draft',
        progress     SMALLINT     DEFAULT 0,
        scheduled_at DATE,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ── AUDIT LOG ──────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id          SERIAL PRIMARY KEY,
        user_id     INT REFERENCES users(id) ON DELETE SET NULL,
        action      VARCHAR(100),
        entity      VARCHAR(60),
        entity_id   INT,
        detail      TEXT,
        ip          VARCHAR(45),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    console.log('✅  All tables created.\n');

    // ── SEED: Admin user ───────────────────────────────────────────────────
    const adminExists = await client.query(`SELECT id FROM users WHERE email = $1`, ['Uniadmin']);
    if (adminExists.rowCount === 0) {
      const hash = await bcrypt.hash('Uniadmin@123', 12);
      await client.query(
        `INSERT INTO users (name, email, password, role, avatar_initials) VALUES ($1,$2,$3,$4,$5)`,
        ['Rajesh Kumar', 'Uniadmin', hash, 'admin', 'RK']
      );
      console.log('✅  Admin user created  →  Uniadmin  /  Uniadmin@123');
    } else {
      console.log('ℹ️   Admin user already exists.');
    }

    // ── SEED: Demo user ────────────────────────────────────────────────────
    const demoExists = await client.query(`SELECT id FROM users WHERE email = $1`, ['demo@unicircuit.com']);
    if (demoExists.rowCount === 0) {
      const hash = await bcrypt.hash('Demo@1234', 12);
      await client.query(
        `INSERT INTO users (name, email, password, role, avatar_initials) VALUES ($1,$2,$3,$4,$5)`,
        ['Demo User', 'demo@unicircuit.com', hash, 'user', 'DU']
      );
      console.log('✅  Demo user created   →  demo@unicircuit.com   /  Demo@1234');
    }

    // ── SEED: Contacts ─────────────────────────────────────────────────────
    const cCount = await client.query(`SELECT COUNT(*) FROM contacts`);
    if (parseInt(cCount.rows[0].count) === 0) {
      const rows = [
        ['Suresh','Kumar','L&T ECC','Sr. Purchase Manager','Procurement','+91 98200 44512','+91 98200 44512','suresh.k@larsentoubro.com','Hot Lead',88,'MCC Panels, Cable Trays','Mumbai','Key decision maker. Discussed Panel Wiring for Faridabad plant.','#1d4ed8','rgba(29,78,216,0.15)','SK',24,38,12,'Today'],
        ['Vijay','Rao','BHEL','Procurement Officer','Purchase','+91 11 2337 8800','+91 98765 10001','vijay.rao@bhel.in','Client',74,'VFDs, PLC Panels, DB Boxes','Delhi','Long-term client. Regular orders for VFDs. Tender deadline April 10.','#d97706','rgba(217,119,6,0.15)','VR',18,22,6,'Today'],
        ['Anita','Sharma','Siemens India Partner','Business Dev Manager','Sales','+91 80 4112 3390','+91 80 4112 3390','anita.s@siemenspartner.in','Prospect',61,'Power Quality Analysers','Bengaluru','Interested in Power Quality Analysers. Requested demo next week.','#7c3aed','rgba(124,58,237,0.15)','AS',7,14,2,'Yesterday'],
        ['Rohit','Joshi','Schneider Electric','Zone Sales Engineer','B2B Sales','+91 22 6789 0000','','rohit.j@schneider.com','Client',42,'Modular Switching Units','Pune','Order #SE-24-901 awaiting confirmation.','#059669','rgba(5,150,105,0.15)','RJ',5,9,0,'3 days ago'],
        ['Priya','Nair','ABB India Ltd','Project Engineer','Engineering','+91 80 2222 9999','+91 90000 55555','priya.n@abb.com','Prospect',35,'Switchgear, Relays','Bengaluru','Exploring switchgear solutions for upcoming plant project.','#dc2626','rgba(220,38,38,0.15)','PN',3,5,1,'Last week'],
        ['Manish','Gupta','Adani Power','Head - Electrical','Projects','+91 79 2555 0000','+91 98001 22222','manish.g@adani.com','Hot Lead',82,'HT Panels, ACBs, SCADA','Ahmedabad','Major opportunity for HT panel supply. Meeting scheduled.','#0891b2','rgba(8,145,178,0.15)','MG',9,16,8,'Today'],
        ['Deepak','Verma','NTPC Ltd','Purchase Officer','Procurement','+91 11 4444 7777','','deepak.v@ntpc.co.in','Prospect',55,'Cable Trays, DB Panels','Noida','Re-engaging for cable management solutions.','#65a30d','rgba(101,163,13,0.15)','DV',4,7,0,'2 weeks ago'],
        ['Kavita','Shah','Torrent Power','GM - Procurement','Supply Chain','+91 79 2730 0000','+91 97000 44444','kavita.s@torrentpower.com','Vendor',68,'Switchgear, Transformers','Ahmedabad','Strategic vendor relationship.','#9333ea','rgba(147,51,234,0.15)','KS',6,12,4,'4 days ago'],
      ];
      for (const r of rows) {
        await client.query(`
          INSERT INTO contacts (fname,lname,company,designation,dept,phone,wa,email,segment,score,products,city,notes,avatar_color,avatar_bg,initials,calls,emails_count,wa_count,last_contact)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
        `, r);
      }
      console.log('✅  Contacts seeded (8 records).');
    }

    // ── SEED: Pipeline deals ───────────────────────────────────────────────
    const dCount = await client.query(`SELECT COUNT(*) FROM pipeline_deals`);
    if (parseInt(dCount.rows[0].count) === 0) {
      const deals = [
        ['L&T – MCC Panel Supply','L&T ECC','₹12.4L','Negotiation',88,'Amit S.','Apr 15'],
        ['BHEL – VFD Bundle','BHEL','₹8.1L','Proposal Sent',74,'Rajesh K.','Apr 10'],
        ['Adani Power – HT Panels','Adani Power','₹22L','Qualified',82,'Rajesh K.','Apr 30'],
        ['Siemens – PQA Demo to Order','Siemens Partner','₹3.2L','Prospect',61,'Priya N.','May 5'],
        ['Schneider – MSU Confirmation','Schneider','₹1.8L','Won',42,'Amit S.','Done'],
        ['NTPC – Cable Trays RFQ','NTPC','₹5.6L','Qualified',55,'Rajesh K.','Apr 20'],
      ];
      for (const d of deals) {
        await client.query(`
          INSERT INTO pipeline_deals (name,company,value,stage,score,owner,due_date)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
        `, d);
      }
      console.log('✅  Pipeline deals seeded (6 records).');
    }

    // ── SEED: Call logs ────────────────────────────────────────────────────
    const lCount = await client.query(`SELECT COUNT(*) FROM call_logs`);
    if (parseInt(lCount.rows[0].count) === 0) {
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      const logs = [
        [today,'10:30:00','Amit Sharma','201','+91 98200 44512','4m 12s','Out',null],
        [today,'10:45:00','L&T ECC','+91 22 6121 8800','Ext. 305 Sales','18m 47s','In','Discussed quotation for Panel Wiring. Follow-up required by April 8.'],
        [today,'11:00:00','Priya Nair','108','+91 80 4112 3390','—','Missed',null],
        [today,'11:20:00','BHEL Procurement',null,'Ext. 305 Sales','9m 03s','In',null],
        [today,'11:35:00','Rajan – Purchase','202','Ext. 401 Accounts','2m 55s','Internal',null],
      ];
      for (const l of logs) {
        await client.query(`
          INSERT INTO call_logs (call_date,call_time,caller,extension,destination,duration,call_type,ai_summary)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `, l);
      }
      console.log('✅  Call logs seeded (5 records).');
    }

    // ── SEED: Campaigns ────────────────────────────────────────────────────
    const campCount = await client.query(`SELECT COUNT(*) FROM campaigns`);
    if (parseInt(campCount.rows[0].count) === 0) {
      const camps = [
        ['Q2 Switchgear Promotion','MCB Distribution Boards','Client','Email','Active',60],
        ['Cable Tray Flash Sale – WA','Cable Trays','Hot Lead','WhatsApp','Active',78],
        ['VFD Follow-up Call Blitz','VFDs','Prospect','Voice','Scheduled',28],
      ];
      for (const c of camps) {
        await client.query(`
          INSERT INTO campaigns (name,product,segment,channel,status,progress)
          VALUES ($1,$2,$3,$4,$5,$6)
        `, c);
      }
      console.log('✅  Campaigns seeded (3 records).');
    }

    console.log('\n🎉  Database ready!\n');
    console.log('   Login:  Uniadmin  /  Uniadmin@123\n');

  } catch (err) {
    console.error('\n❌  Init failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

init();
