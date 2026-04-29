# UniComm Pro — Unicircuit Engineering Services LLP

Full-stack omnichannel CRM with Login, Dashboard, and PostgreSQL backend.

---

## Project Structure

```
├── login.html          ← Login page (open this first)
├── dashboard.html      ← Main dashboard (redirected to after login)
├── UniComm_Pro_Unicircuit.html  ← Original reference file
└── backend/
    ├── server.js       ← Express API server (port 3001)
    ├── .env.example    ← Copy to .env and fill in DB credentials
    ├── db/
    │   ├── pool.js     ← PostgreSQL connection pool
    │   └── init.js     ← DB schema creation + seed data
    ├── middleware/
    │   └── auth.js     ← JWT authentication middleware
    └── routes/
        ├── auth.js         ← Login / logout / me
        ├── contacts.js     ← CRUD contacts
        ├── pipeline.js     ← CRUD pipeline deals
        ├── calls.js        ← Call logs
        ├── campaigns.js    ← Marketing campaigns
        └── dashboard.js    ← Aggregated KPI stats
```

---

## Quick Start

### 1. PostgreSQL Setup

Create the database:
```sql
CREATE DATABASE unicomm_db;
```

### 2. Backend Setup

```bash
cd backend

# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env — set DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, JWT_SECRET

# Initialise database (creates tables + seeds demo data)
npm run db:init

# Start the API server
npm start
# or for development with auto-reload:
npm run dev
```

API runs on **http://localhost:3001**

### 3. Open the Frontend

Open `login.html` in your browser (use Live Server or any static server).

---

## Demo Credentials

| Role  | Email                    | Password    |
|-------|--------------------------|-------------|
| Admin | admin@unicircuit.com     | Admin@1234  |
| User  | demo@unicircuit.com      | Demo@1234   |

> **Offline mode**: If the backend is not running, the login page still works with the demo credentials above (data is stored locally in the browser).

---

## API Endpoints

| Method | Endpoint                    | Description              |
|--------|-----------------------------|--------------------------|
| POST   | /api/auth/login             | Login → returns JWT      |
| POST   | /api/auth/logout            | Logout (audit log)       |
| GET    | /api/auth/me                | Current user info        |
| GET    | /api/contacts               | List contacts            |
| POST   | /api/contacts               | Create contact           |
| PUT    | /api/contacts/:id           | Update contact           |
| DELETE | /api/contacts/:id           | Delete contact           |
| GET    | /api/pipeline               | List pipeline deals      |
| POST   | /api/pipeline               | Create deal              |
| PUT    | /api/pipeline/:id           | Update deal              |
| DELETE | /api/pipeline/:id           | Delete deal              |
| GET    | /api/calls                  | List call logs           |
| POST   | /api/calls                  | Add call log             |
| PATCH  | /api/calls/:id/summary      | Save AI summary          |
| GET    | /api/campaigns              | List campaigns           |
| POST   | /api/campaigns              | Create campaign          |
| DELETE | /api/campaigns/:id          | Delete campaign          |
| GET    | /api/dashboard/stats        | KPI aggregates           |
| GET    | /api/health                 | Health check             |

All endpoints except `/api/auth/login` and `/api/health` require:
```
Authorization: Bearer <jwt_token>
```

---

## Database Schema

- **users** — login accounts with bcrypt passwords
- **contacts** — CRM contacts with lead scoring
- **pipeline_deals** — sales pipeline stages
- **call_logs** — PBX call records with AI summaries
- **campaigns** — marketing campaigns
- **audit_log** — login/logout/create/update/delete trail
