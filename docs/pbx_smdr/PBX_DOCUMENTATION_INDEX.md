# PBX Connection Documentation Index

## Overview
Complete documentation for the Matrix Eternity PBX SMDR connection issue and solution.

**Issue**: Dashboard shows 🟡 yellow instead of 🟢 green
**Root Cause**: PBX sending SMDR Report instead of SMDR Online (needs service restart)
**Solution**: Restart SMDR service on PBX

---

## Quick Start (5 Minutes)

### For Users Who Just Want to Fix It
👉 **Start here**: [`QUICK_FIX.md`](QUICK_FIX.md)
- 3-step fix
- Expected results
- Quick troubleshooting

---

## Comprehensive Guides

### 1. Solution Summary
📄 **File**: [`SOLUTION_SUMMARY.md`](../crm_reports/SOLUTION_SUMMARY.md)
- Problem statement
- Root cause analysis
- Solution overview
- Verification checklist
- What changed in code

**Read this if**: You want to understand the full picture

---

### 2. Troubleshooting Guide
🔧 **File**: [`PBX_CONNECTION_TROUBLESHOOTING.md`](PBX_CONNECTION_TROUBLESHOOTING.md)
- Current status
- Root cause analysis
- Step-by-step solution
- Verification checklist
- If it still doesn't work (detailed checks)
- Technical details
- Configuration files
- Support resources

**Read this if**: You need detailed troubleshooting steps

---

### 3. Visual Guide
📊 **File**: [`VISUAL_GUIDE.md`](VISUAL_GUIDE.md)
- Current state diagram
- After fix diagram
- Handshake protocol sequence
- Dashboard state transitions
- Data flow diagram
- Network diagram
- Troubleshooting decision tree

**Read this if**: You prefer visual explanations

---

### 4. Technical Protocol Details
🔬 **File**: [`SMDR_PROTOCOL_DETAILS.md`](SMDR_PROTOCOL_DETAILS.md)
- SMDR Online protocol (OG Handshaking)
- Connection flow
- Call record format
- SMDR Report format
- Server implementation
- Socket.IO events
- Troubleshooting decision tree
- Performance metrics
- Configuration details
- References

**Read this if**: You want deep technical understanding

---

### 5. Implementation Checklist
✅ **File**: [`IMPLEMENTATION_CHECKLIST.md`](../checklists/IMPLEMENTATION_CHECKLIST.md)
- Pre-fix verification
- Fix implementation steps
- Post-fix verification
- Troubleshooting checklist
- Performance verification
- Sign-off section
- Rollback plan
- Next steps

**Read this if**: You're implementing the fix and want to track progress

---

## File Organization

```
UNI_CRM/
├── docs/
│   ├── pbx_smdr/
│   │   ├── QUICK_FIX.md                      ← START HERE (5 min)
│   │   ├── PBX_CONNECTION_TROUBLESHOOTING.md ← Full guide (20 min)
│   │   ├── VISUAL_GUIDE.md                   ← Diagrams (15 min)
│   │   ├── SMDR_PROTOCOL_DETAILS.md          ← Technical (30 min)
│   │   └── PBX_DOCUMENTATION_INDEX.md        ← This file
│   ├── checklists/
│   │   └── IMPLEMENTATION_CHECKLIST.md       ← Tracking (ongoing)
│   └── crm_reports/
│       └── SOLUTION_SUMMARY.md               ← Overview (10 min)
│
├── backend/
│   ├── services/
│   │   └── matrixSmdr.js                     ← Enhanced logging
│   ├── server.js                             ← No changes
│   └── .env                                  ← Configuration
│
└── [Other project files...]
```

---

## Reading Paths

### Path 1: "Just Fix It" (5 minutes)
1. [`QUICK_FIX.md`](QUICK_FIX.md) — 3-step fix
2. Restart SMDR service on PBX
3. Verify dashboard shows 🟢 green

### Path 2: "I Want to Understand" (30 minutes)
1. [`SOLUTION_SUMMARY.md`](../crm_reports/SOLUTION_SUMMARY.md) — Overview
2. [`VISUAL_GUIDE.md`](VISUAL_GUIDE.md) — Diagrams
3. [`PBX_CONNECTION_TROUBLESHOOTING.md`](PBX_CONNECTION_TROUBLESHOOTING.md) — Details

### Path 3: "I Need to Troubleshoot" (45 minutes)
1. [`QUICK_FIX.md`](QUICK_FIX.md) — Try the fix
2. [`PBX_CONNECTION_TROUBLESHOOTING.md`](PBX_CONNECTION_TROUBLESHOOTING.md) — Detailed checks
3. [`SMDR_PROTOCOL_DETAILS.md`](SMDR_PROTOCOL_DETAILS.md) — Technical deep-dive

### Path 4: "I'm Implementing This" (60+ minutes)
1. [`SOLUTION_SUMMARY.md`](../crm_reports/SOLUTION_SUMMARY.md) — Understand the issue
2. [`IMPLEMENTATION_CHECKLIST.md`](../checklists/IMPLEMENTATION_CHECKLIST.md) — Track progress
3. [`PBX_CONNECTION_TROUBLESHOOTING.md`](PBX_CONNECTION_TROUBLESHOOTING.md) — Troubleshoot as needed
4. [`SMDR_PROTOCOL_DETAILS.md`](SMDR_PROTOCOL_DETAILS.md) — Reference for details

### Path 5: "I'm a Developer" (90+ minutes)
1. [`SMDR_PROTOCOL_DETAILS.md`](SMDR_PROTOCOL_DETAILS.md) — Protocol details
2. [`VISUAL_GUIDE.md`](VISUAL_GUIDE.md) — Architecture diagrams
3. Read `backend/services/matrixSmdr.js` — Implementation
4. [`PBX_CONNECTION_TROUBLESHOOTING.md`](PBX_CONNECTION_TROUBLESHOOTING.md) — Troubleshooting

---

## Key Concepts

### The Problem
- Dashboard shows 🟡 yellow (listening) instead of 🟢 green (connected)
- PBX is connecting and sending data
- But data format is wrong (SMDR Report instead of SMDR Online)

### The Root Cause
- PBX configured for SMDR Online but still sending SMDR Report
- Happens because SMDR service hasn't been restarted after config change
- First byte is CRLF (0x0d0a) instead of ENQ (0x00)

### The Solution
- Restart SMDR service on PBX (System → Services → SMDR)
- PBX will switch to SMDR Online format
- Server will receive ENQ handshake
- Dashboard will show 🟢 green

### The Fix
- Enhanced logging in `backend/services/matrixSmdr.js`
- Tells users exactly what's wrong and how to fix it
- Graceful fallback for both protocols

---

## Code Changes

### Modified Files
- `backend/services/matrixSmdr.js` — Enhanced diagnostic logging

### What Changed
Added detailed console.log messages to help users understand:
1. When ENQ is NOT received
2. Why this means SMDR Report format
3. How to fix it (restart SMDR service)

### Backward Compatibility
✓ All changes are backward-compatible
✓ No breaking changes
✓ Graceful fallback for both protocols
✓ Can be reverted with: `git checkout backend/services/matrixSmdr.js`

---

## Verification

### Before Fix
```
[SMDR] ⚠️  Expected ENQ (0x00) but got: [13,10] (CRLF)
[SMDR]    Treating as raw data (no handshaking)
[SMDR]    This usually means PBX is sending SMDR Report instead of SMDR Online
[SMDR]    FIX: Restart SMDR service on PBX (System → Services → SMDR)
```

### After Fix
```
[SMDR] 🤝 Received ENQ handshake from 192.168.0.81
[SMDR] 🤝 Sent ACK response to 192.168.0.81
[SMDR] ✅ Emitting pbx:connected event (OG-Handshaking protocol)
```

---

## Support Resources

### Internal Documentation
- [`QUICK_FIX.md`](QUICK_FIX.md) — Quick reference
- [`SOLUTION_SUMMARY.md`](../crm_reports/SOLUTION_SUMMARY.md) — Full overview
- [`PBX_CONNECTION_TROUBLESHOOTING.md`](PBX_CONNECTION_TROUBLESHOOTING.md) — Troubleshooting
- [`SMDR_PROTOCOL_DETAILS.md`](SMDR_PROTOCOL_DETAILS.md) — Technical details
- [`VISUAL_GUIDE.md`](VISUAL_GUIDE.md) — Diagrams
- [`IMPLEMENTATION_CHECKLIST.md`](../checklists/IMPLEMENTATION_CHECKLIST.md) — Tracking

### External Resources
- **PBX Web Interface**: `http://192.168.0.81:8080`
- **Matrix Documentation**: ETERNITY NE V1R7.3.3 System Manual
- **Server Logs**: Terminal where `node server.js` is running
- **Dashboard**: `http://192.168.0.169:8088/dashboard.html`

---

## Timeline

- **May 18, 2026**: PBX connection implemented with 3-state model
- **May 20, 2026**: Socket data handler indentation fixed
- **May 22, 2026**: OG handshaking protocol implemented
- **May 22, 2026**: Diagnostic logging added
- **May 22, 2026**: Comprehensive documentation created

---

## FAQ

### Q: Why is the dashboard showing 🟡 yellow?
A: The PBX is sending SMDR Report format instead of SMDR Online format. This happens because the SMDR service on the PBX hasn't been restarted after configuration changes.

### Q: How do I fix it?
A: Restart the SMDR service on the PBX (System → Services → SMDR). Stop it, wait 5 seconds, then start it again.

### Q: How long does it take to fix?
A: About 5 minutes. Restart takes 10 seconds, then the dashboard should show 🟢 green immediately.

### Q: Will this break anything?
A: No. The fix is just enhanced logging. The server gracefully handles both SMDR Online and SMDR Report formats.

### Q: What if it still doesn't work?
A: See [`PBX_CONNECTION_TROUBLESHOOTING.md`](PBX_CONNECTION_TROUBLESHOOTING.md) for detailed troubleshooting steps.

### Q: Can I revert the changes?
A: Yes, with: `git checkout backend/services/matrixSmdr.js`. But the enhanced logging is helpful for debugging.

---

## Next Steps

1. **Read**: [`QUICK_FIX.md`](QUICK_FIX.md) (5 minutes)
2. **Implement**: Restart SMDR service on PBX (5 minutes)
3. **Verify**: Dashboard shows 🟢 green (1 minute)
4. **Test**: Make a test call (2 minutes)
5. **Done**: System working correctly ✓

---

## Document Metadata

- **Created**: May 22, 2026
- **Last Updated**: May 22, 2026
- **Status**: Complete
- **Version**: 1.0
- **Author**: Kiro AI Development Environment

---

## Quick Links

| Document | Purpose | Time |
|----------|---------|------|
| [`QUICK_FIX.md`](QUICK_FIX.md) | Quick reference | 5 min |
| [`SOLUTION_SUMMARY.md`](../crm_reports/SOLUTION_SUMMARY.md) | Overview | 10 min |
| [`PBX_CONNECTION_TROUBLESHOOTING.md`](PBX_CONNECTION_TROUBLESHOOTING.md) | Full guide | 20 min |
| [`VISUAL_GUIDE.md`](VISUAL_GUIDE.md) | Diagrams | 15 min |
| [`SMDR_PROTOCOL_DETAILS.md`](SMDR_PROTOCOL_DETAILS.md) | Technical | 30 min |
| [`IMPLEMENTATION_CHECKLIST.md`](../checklists/IMPLEMENTATION_CHECKLIST.md) | Tracking | Ongoing |

---

**Start with**: [`QUICK_FIX.md`](QUICK_FIX.md)

