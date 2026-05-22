# Implementation Checklist

## Pre-Fix Verification

- [ ] Dashboard shows 🟡 yellow indicator
- [ ] Server logs show: `[SMDR] ⚠️  Expected ENQ (0x00) but got: [13,10]`
- [ ] Server logs show: `[SMDR]    Treating as raw data (no handshaking)`
- [ ] Call logs are being saved to database
- [ ] PBX is connecting to server (confirmed in logs)

---

## Fix Implementation

### Step 1: Restart SMDR Service on PBX

- [ ] Open PBX web interface: `http://192.168.0.81:8080`
- [ ] Login with admin credentials
- [ ] Navigate to: **System → Services**
- [ ] Find "SMDR" service in the list
- [ ] Click **Stop** button
- [ ] Wait 5 seconds for service to stop
- [ ] Verify service shows "Stopped" status
- [ ] Click **Start** button
- [ ] Wait 10 seconds for service to fully initialize
- [ ] Verify service shows "Running" status

### Step 2: Monitor Server Logs

- [ ] Open terminal where server is running
- [ ] Look for new connection from PBX
- [ ] Verify you see: `[SMDR] 🤝 Received ENQ handshake from 192.168.0.81`
- [ ] Verify you see: `[SMDR] 🤝 Sent ACK response to 192.168.0.81`
- [ ] Verify you see: `[SMDR] ✅ Emitting pbx:connected event (OG-Handshaking protocol)`

### Step 3: Verify Dashboard Update

- [ ] Refresh dashboard in browser (F5)
- [ ] Check PBX status indicator
- [ ] Verify indicator is now 🟢 green (not 🟡 yellow)
- [ ] Verify status text shows: "Matrix PBX · Live Connected · Receiving Realtime SMDR Data"
- [ ] Verify "Live" badge is visible
- [ ] Verify listener info shows: "Active SMDR session from 192.168.0.81"

---

## Post-Fix Verification

### Test 1: Make a Test Call

- [ ] Make a call from any extension (internal or external)
- [ ] Note the time of the call
- [ ] Note the caller and destination numbers
- [ ] Note the duration

### Test 2: Verify Call Appears in Log

- [ ] Check dashboard call log
- [ ] Verify call appears within 5 seconds
- [ ] Verify caller number is correct
- [ ] Verify destination number is correct
- [ ] Verify call type is correct (In/Out)
- [ ] Verify duration is approximately correct

### Test 3: Verify CRM Integration

- [ ] Check if caller is in CRM contacts
- [ ] If yes, verify contact's call count incremented
- [ ] If yes, verify "last_contact" timestamp updated
- [ ] If no, verify new contact was created (if auto-create enabled)

### Test 4: Make Multiple Calls

- [ ] Make 3-5 more test calls
- [ ] Verify all calls appear in log
- [ ] Verify no duplicates in log
- [ ] Verify all call details are accurate

### Test 5: Verify Real-Time Updates

- [ ] Make a call
- [ ] Watch dashboard in real-time
- [ ] Verify call appears immediately (within 1-2 seconds)
- [ ] Verify no page refresh needed
- [ ] Verify notification appears (if enabled)

---

## Troubleshooting Checklist

### If Dashboard Still Shows 🟡 Yellow

- [ ] Verify SMDR service is actually running on PBX
  - [ ] Check: System → Services → SMDR status
  - [ ] If stopped, click Start again
  - [ ] Wait 10 seconds

- [ ] Verify server is still listening
  - [ ] Run: `netstat -ano | findstr :5000`
  - [ ] Should show: `LISTENING`
  - [ ] If not, restart server: `node server.js`

- [ ] Verify firewall rule is active
  - [ ] Run: `netsh advfirewall firewall show rule name="PBX-SMDR"`
  - [ ] Should show: `Enabled: Yes`
  - [ ] If not, recreate rule

- [ ] Check server logs for errors
  - [ ] Look for: `[SMDR] ❌` or `[SMDR] ⚠️`
  - [ ] Note any error messages
  - [ ] Check network connectivity

### If Calls Don't Appear in Log

- [ ] Verify call was actually made
  - [ ] Check PBX call history
  - [ ] Verify call duration > 0 seconds

- [ ] Check server logs for parsing errors
  - [ ] Look for: `[SMDR] ✅ Parsed successfully`
  - [ ] If not present, check raw line format

- [ ] Verify database is accessible
  - [ ] Check: `SELECT COUNT(*) FROM call_logs`
  - [ ] Should return a number > 0

- [ ] Check for duplicate detection
  - [ ] Look for: `[SMDR] Duplicate raw event ignored`
  - [ ] This is normal for repeated calls

### If CRM Contact Not Updated

- [ ] Verify contact exists in CRM
  - [ ] Search by phone number
  - [ ] Check exact format (with/without +91)

- [ ] Check database for contact
  - [ ] Query: `SELECT * FROM contacts WHERE phone LIKE '%9545073545%'`
  - [ ] Verify contact ID exists

- [ ] Check call_logs for correct number
  - [ ] Query: `SELECT * FROM call_logs ORDER BY created_at DESC LIMIT 1`
  - [ ] Verify caller/destination matches contact phone

---

## Performance Verification

### Latency Check

- [ ] Make a call and note exact time
- [ ] Check when call appears in dashboard
- [ ] Calculate latency: dashboard_time - call_time
- [ ] Should be < 5 seconds
- [ ] Typical: 1-2 seconds

### Throughput Check

- [ ] Make 10 calls in quick succession
- [ ] Verify all 10 appear in log
- [ ] Verify no calls are dropped
- [ ] Verify no duplicates

### Reliability Check

- [ ] Leave system running for 1 hour
- [ ] Make calls periodically
- [ ] Verify all calls logged
- [ ] Verify no disconnections
- [ ] Check server logs for errors

---

## Documentation Verification

- [ ] Read: `QUICK_FIX.md` — Quick reference
- [ ] Read: `PBX_CONNECTION_TROUBLESHOOTING.md` — Full guide
- [ ] Read: `SMDR_PROTOCOL_DETAILS.md` — Technical details
- [ ] Read: `VISUAL_GUIDE.md` — Diagrams and flows
- [ ] Read: `SOLUTION_SUMMARY.md` — Overview

---

## Sign-Off

### Successful Implementation
- [ ] Dashboard shows 🟢 green
- [ ] Calls appear in real-time
- [ ] CRM contacts updated
- [ ] No errors in logs
- [ ] All tests passed

### Date Completed: _______________

### Verified By: _______________

### Notes:
```
[Space for notes]
```

---

## Rollback Plan (If Needed)

If something goes wrong:

1. **Stop server**: Press Ctrl+C in terminal
2. **Revert code**: `git checkout backend/services/matrixSmdr.js`
3. **Restart server**: `node server.js`
4. **Verify**: Dashboard should still work (may show 🟡 yellow)

Note: The code changes are backward-compatible and don't break anything. The only change is enhanced logging.

---

## Next Steps After Successful Implementation

1. **Monitor for 24 hours**: Ensure stability
2. **Document any issues**: For future reference
3. **Update runbooks**: Add PBX restart procedure
4. **Train team**: On new dashboard features
5. **Schedule maintenance**: Regular SMDR service health checks

---

## Contact & Support

- **PBX Web Interface**: `http://192.168.0.81:8080`
- **Server Logs**: Terminal where `node server.js` is running
- **Dashboard**: `http://192.168.0.169:8088/dashboard.html`
- **Database**: PostgreSQL on 192.168.0.169:5432

