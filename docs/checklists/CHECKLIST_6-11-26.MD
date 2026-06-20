# 🚀 Deployment Checklist & Detailed Changelog - June 11, 2026

This checklist summarizes every specific Git commit and file change that has been pushed to the `main` branch today, breaking down exactly what was modified in the code.

## 📝 Detailed File Changes

### Frontend (`dashboard.html`)
- [ ] Added `makeFolderGroup` and `makeExtItem` helper functions to render collapsible PBX folders with recording counts.
- [ ] Created `__ALL__` virtual node rendering logic to aggregate all recordings across all backup folders into a single view.
- [ ] Updated breadcrumbs to display `All › [Extension]` when in the virtual All folder.
- [ ] Updated `showWaDirectoryDetail` to gracefully display "Phone resolving..." and "Resolving in background..." for pending `@lid` WA contacts.
- [ ] Removed forced `waLoadChats({ force: true })` on LID batch completion to improve UI performance and stop flashing.
- [ ] Added Insights panel with Charts modal (`ins-charts-modal`) and AI Summary UI via `PicoClaw`.
- [ ] Added activity badge styling and mapping `_actMeta` for system activity logs.

### Backend: `backend/routes/dashboard.js`
- [ ] Implemented a completely new `/api/dashboard/insights` endpoint to serve stats for the new UI.
- [ ] Replaced the dependency on `call_logs_deduped` view with a direct query to `call_logs` utilizing a `LEFT JOIN pbx_contacts` to get `contact_name`.
- [ ] Reduced the `New calls in period` limit from 50 to 20.
- [ ] Added detailed SQL query error logging with `sql.slice(0,120)` in `safeQuery()`.
- [ ] Fixed WA Insights query by replacing `jid` with `id` (`WHERE id LIKE '%@g.us'`).
- [ ] Refactored WA `business` stat counting from `FILTER` to a direct subselect on `wa_contacts`.
- [ ] Added a database fallback to resolve `waAccountPhone` from `wa_chats` if `wa.getConnectedPhone()` is empty.
- [ ] Merged "today vs yesterday" comparison queries into the main `Promise.all` block to prevent serial execution delays.

### Backend: `backend/routes/pbx.js`
- [ ] Added `isAll` condition to bypass `backfillPBXRecordingMetadata` when the `backupFolder` is `__ALL__`.

### Backend: `backend/routes/calls.js`
- [ ] Added `AND cl.call_type = 'Out'` to contact lookup joins in `/contact/:phone`, `/`, and `/section-summary` endpoints to optimize matching logic.

### Backend: `backend/routes/whatsapp.js`
- [ ] Added `WHERE wc.name IS NULL AND wc.notify IS NULL` and `WHERE wc.phone IS NOT NULL` conditions when doing `LATERAL` joins to fetch missing contact/sender details.
- [ ] Added new endpoints for syncing chat labels and read status.

### Backend: `backend/services/whatsapp.js`
- [ ] Accelerated group and LID resolution sync speeds:
  - `GROUP_METADATA_CONCURRENCY` increased from 1 to 2
  - `GROUP_METADATA_DELAY_MS` reduced from 1200 to 600
  - `LID_RESOLUTION_BATCH_DELAY_MS` reduced from 5000 to 2500
  - `MAX_GROUPS_PER_LID_BATCH` increased from 8 to 16
- [ ] Added missing database indices for performance:
  - `idx_wa_contacts_phone`
  - `idx_wa_messages_sender_name`
  - `idx_wa_chats_id`
  - `idx_wa_contacts_group_member`

### Backend: `backend/services/matrixSmdr.js`
- [ ] Added database index `idx_audit_log_created_at` to speed up audit log querying.

### Other / Config
- [ ] `.kiro/steering/deployment-checklist.md`: Added notes regarding contact duplicate handling deployment.

---

## ⚠️ Notes for Production Deployment
- **SQL Updates:** While many queries were refactored, the required indexing (`idx_audit_log_created_at`, `idx_wa_contacts_phone`, etc.) is managed automatically in code via the `ensureTables` logic in the respective services upon startup. No manual `CREATE TABLE` or `CREATE INDEX` queries need to be run via PSQL.
- **Restart PM2:** Run `pm2 restart unicomm --update-env` after pulling these changes to the Tower Server.
