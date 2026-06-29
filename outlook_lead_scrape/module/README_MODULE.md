
# UniComm Pro — Outlook Lead Scrape Module

Automatic buyer/sales-inquiry detection + structured lead extraction from the
`outlook_emails_cache` mail snapshots, with idempotent insert into the `leads`
table. **No frontend, no dashboard changes.**

## Files

| File                            | Role                                                         |
| ------------------------------- | ------------------------------------------------------------ |
| `leadBrain.js`                | Classification + field extraction (rules-first, AI-fallback) |
| `outlookLeadScrapeService.js` | Background worker:`start`, `stop`, `runOnce`           |
| `leadDedup.js`                | Idempotency + duplicate detection                            |
| `ensureTables.js`             | Creates`outlook_lead_processed` table                      |

## Install

The module has **zero new npm dependencies** — it uses your existing project's
`pg` pool, `msGraph.js`, `ollamaService.js`, and `activityLog.js`.

Drop the `module/` folder contents into:

```
backend/services/outlook_lead_scrape/      (or wherever your services live)
```

If your path differs, adjust the lazy `require(...)` paths at the top of
`leadDedup.js`, `ensureTables.js`, and `outlookLeadScrapeService.js`.
Each loader tries `../../backend/...`, `../../../backend/...`, and `../backend/...`
so it should resolve in most layouts.

## Environment variables

| Var                            | Default   | Purpose                                       |
| ------------------------------ | --------- | --------------------------------------------- |
| `LEAD_SCRAPE_MAX_EMAILS`     | `50`    | Max emails scanned per pass                   |
| `LEAD_SCRAPE_SINCE_HOURS`    | `24`    | Look-back window                              |
| `LEAD_SCRAPE_MIN_CONFIDENCE` | `0.60`  | Insert threshold                              |
| `LEAD_SCRAPE_INTERVAL_MIN`   | `5`     | Scheduler interval (minutes)                  |
| `LEAD_SCRAPE_USE_AI`         | `false` | Enable Groq AI fallback for ambiguous emails  |
| `MS_USER_EMAIL`              | —        | Shared mailbox for MS Graph full-body fetch   |
| `AI_API_KEY`                 | —        | Groq key (existing, used by`ollamaService`) |

## Wire into `server.js`

```js
// after `const io = ...` and app/express are initialized
const outlookLeadScrape = require('./services/outlook_lead_scrape/outlookLeadScrapeService');

// start background scheduler (every 5 min by default)
outlookLeadScrape.start(io, parseInt(process.env.LEAD_SCRAPE_INTERVAL_MIN || '5', 10));

// optional: manual trigger route
app.post('/api/outlook/scrape-leads', async (req, res) => {
  const summary = await outlookLeadScrape.runOnce({ trigger: 'manual', io });
  res.json(summary);
});

// optional: react to mail-sync event
// io.on('outlook:mail_synced', () => outlookLeadScrape.runOnce({ trigger: 'sync' }));
```

## Idempotency table (auto-created)

```sql
CREATE TABLE IF NOT EXISTS outlook_lead_processed (
  message_id    TEXT PRIMARY KEY,
  lead_id       INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  confidence    NUMERIC(4,3),
  status        VARCHAR(20) NOT NULL,   -- inserted | rejected | duplicate | error
  reason        TEXT,
  processed_at  TIMESTAMPTZ DEFAULT NOW()
);
```

Every processed message is recorded (even rejections) so it is never scanned twice.

## Manual test

```bash
node -e "require('./outlookLeadScrapeService').runOnce({trigger:'test'}).then(r=>console.log(r))"
```

## Run unit tests

```bash
cd outlook_lead_scrape/module
npm test
```

Tests use only Node's built-in `assert` — no test framework needed.

## Tuning lead detection rules

All classification vocabulary lives at the top of `leadBrain.js`:

- `PORTAL_DOMAINS` — Tier-1 B2B portals (auto high-confidence)
- `INTERNAL_DOMAINS` — internal company domains (always rejected)
- `PRODUCT_TERMS` — Unicircuit product keywords
- `LEAD_KEYWORDS` — inquiry/quotation signals
- `HARD_REJECT_SUBJECT` — regex patterns for OTP/newsletter/etc.

Add new terms to the relevant array — no other changes needed.

## Behavior notes

- **Never deletes speech/data**: rejected emails are recorded, not erased.
- **Duplicate handling**: same `phone_norm()` phone within 14 days, or exact
  subject within 7 days → recorded as `duplicate`, no new lead row.
- **AI budget**: only tier-3 (confidence 0.50–0.74) emails call Groq, and only
  when `LEAD_SCRAPE_USE_AI=true`. AI failure falls back to rules-only.
- **Concurrency**: a single `isRunning` lock prevents overlapping passes.
