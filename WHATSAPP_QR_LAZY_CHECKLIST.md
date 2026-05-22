# WhatsApp QR Lazy Connection Checklist

Generated from current `git diff` after the WhatsApp QR/session stability changes.

## Completed

- [x] Changed `/api/wa/qr` to request/generate QR on demand via `wa.requestQR()`.
- [x] Added `requestQR()` in `backend/services/whatsapp.js` to start WhatsApp only when QR is requested.
- [x] Added saved-session detection with `hasSavedSession()` so startup can reconnect existing auth without creating a new QR.
- [x] Prevented fresh QR generation when there is no saved WhatsApp session and the user has not opened/requested WhatsApp Biz.
- [x] Suppressed accidental Baileys QR events unless QR generation was explicitly allowed by the WhatsApp Biz flow.
- [x] Kept WhatsApp auto-reconnect behavior for existing connected/saved sessions.
- [x] Prevented logout/reset from immediately restarting WhatsApp and generating another QR.
- [x] Preserved WhatsApp auth on server `SIGINT` shutdown so restarts can reconnect silently.
- [x] Fixed dashboard navigation so clicking `WhatsApp Biz` actually calls `checkWAStatus(true)`.
- [x] Made the top `WA Business` status pill clickable and route to the WhatsApp Biz module.
- [x] Updated the dashboard WhatsApp status check to show the connect banner and request the QR when WhatsApp Biz is opened.

## Verification Done

- [x] `node --check backend\services\whatsapp.js`
- [x] `node --check backend\routes\whatsapp.js`
- [x] `node --check backend\server.js`
- [x] Dashboard inline `<script>` blocks parsed successfully with Node.

## Expected Behavior

- [x] QR is not generated just because the backend starts.
- [x] QR is generated only when WhatsApp Biz is opened/requested.
- [x] Existing saved WhatsApp sessions can reconnect without forcing a new QR.
- [x] Activity logs should avoid unnecessary "WhatsApp QR generated" and avoid disconnect noise caused by idle QR sessions.

## Notes

- The current worktree contains other unrelated changes shown by `git status`; this checklist only covers the WhatsApp QR/session changes.
- Restart the backend and hard refresh the dashboard after these changes.
