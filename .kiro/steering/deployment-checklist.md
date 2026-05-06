---
inclusion: manual
---

# UniComm Pro — Deployment Checklist & Resource Tracker

## Rule: Jab bhi koi naya npm package install karo ya naya file banao

Yeh file update karo taaki tower server pe deploy karte waqt kuch miss na ho.

---

## npm Packages Added (install on tower)

| Package | Reason | Command |
|---|---|---|
| `gif-encoder-2` | Animated GIF generation for marquee emails | `npm install gif-encoder-2` |
| `selfsigned` | SSL cert generation (auto-installed by gen_cert.js) | auto |
| `node-forge` | SSL cert generation (auto-installed by gen_cert.js) | auto |
| `jimp` | Image processing (used in scratch/send_marquee_test.js only) | not needed on tower |

---

## New Files Added (pulled via git)

| File | Purpose |
|---|---|
| `backend/routes/marquee.js` | Serves animated GIF for marquee via `/api/marquee/gif` |
| `backend/scratch/gen_cert.js` | Generates self-signed SSL cert for tower HTTPS |
| `backend/scratch/send_marquee_test.js` | Test script for marquee email (scratch only) |
| `backend/certs/server.key` | SSL private key (generated on tower, NOT in git) |
| `backend/certs/server.crt` | SSL certificate (generated on tower, NOT in git) |

---

## Tower Server .env Changes Required

When deploying to tower (192.168.0.205), these `.env` values must differ from localhost:

```env
# Tower-specific (HTTPS required for Azure OAuth)
MS_REDIRECT_URI=https://192.168.0.205:8088/auth/callback
APP_PUBLIC_URL=https://192.168.0.205:8088
SSL_KEY_PATH=certs/server.key
SSL_CERT_PATH=certs/server.crt

# Localhost (dev machine)
# MS_REDIRECT_URI=http://localhost:8088/auth/callback
# APP_PUBLIC_URL=http://localhost:8088
```

---

## Azure Redirect URI Rules (IMPORTANT)

- `http://` — sirf `localhost` ke saath allowed
- `http://` — kisi bhi IP/domain ke saath **NOT allowed**
- `https://` — kisi bhi IP/domain ke saath allowed

**Matlab:** Tower pe Outlook connect karne ke liye HTTPS mandatory hai.

Azure portal mein dono URIs registered hone chahiye:
- `http://localhost:8088/auth/callback`
- `https://192.168.0.205:8088/auth/callback`

---

## Tower Deploy Steps (after git push)

```powershell
cd C:\UniComm\Unicircuit_UniComm-main
git pull origin main
cd backend
npm install
pm2 restart unicomm --update-env
```

**SSL cert regenerate karna ho (expire ya fresh setup):**
```powershell
cd C:\UniComm\Unicircuit_UniComm-main\backend
node scratch/gen_cert.js
pm2 restart unicomm --update-env
```

---

## Git Token (for tower pull)

Token: `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`
Remote: `https://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@github.com/unicircuites/Unicircuit_UniComm.git`

---

## Broadcast Test Checklist

- [ ] SMTP connected: `noreply@unicircuites.live` via `smtp.office365.com:587`
- [ ] Test email: Dashboard → Marketing → Email Broadcast → Test SMTP
- [ ] Send test broadcast to self before bulk send
- [ ] Marquee in email: Outlook animates, Gmail shows full static text (no clipping)
