# Pending GitHub Push Checklist - 25 May 2026

## Git Status Summary

- [ ] Review tracked changes before commit:
  - `backend/routes/pbx.js`
  - `dashboard.html`
- [ ] Decide whether to include untracked PBX diagnostic files:
  - `backend/matrix_vms_diagnostic.js`
  - `backend/scripts/pbx_deep_scraper.js`
  - `backend/scripts/pbx_scraper.js`
  - `backend/test_matrix_vms.js`
  - `backend/pbx_*.png`
  - `backend/pbx_*report.txt`
- [ ] Avoid accidentally committing generated screenshots/reports unless they are intentionally part of the PBX documentation/debug package.

## Completed Changes

- [x] PBX DB recording filename parsing now uses the white filename as the source of truth.
- [x] Parser handles both filename shapes:
  - `25052026_171842_CT_+919545073545_21.wav`
  - `205_17082024_153054_CT_205_09011074842.wav`
- [x] Parsed filename date/time is converted into sortable DB format:
  - `DDMMYYYY_HHMMSS` -> `YYYY-MM-DD HH:mm:ss`
- [x] Parsed customer number is normalized for filtering:
  - Keeps `+` when present.
  - Matches digit-only searches too.
- [x] Parsed extension number is stored/refreshed from short numeric filename parts.
- [x] Existing DB rows are backfilled/refreshed from `original_filename` when loading a DB recordings folder.
- [x] DB recordings API supports filters:
  - Date from
  - Date to
  - Time from
  - Time to
  - Number search
- [x] DB recordings API sorts by parsed filename call date/time, newest first.
- [x] DB recordings UI now has filter controls above the database recordings list.
- [x] DB recordings UI shows the parsed call date/time and customer number below the white filename.
- [x] Pagination uses backend filters, so filtered results are counted across the full DB folder, not only the visible page.
- [x] Store DB flow now sends a snapshot folder name and shows inserted/updated/duplicate counts.
- [x] Existing recordings can be updated into the latest snapshot folder instead of being silently skipped.
- [x] Latest call recordings are now syncing into the DB after the Matrix SARVAM UCS configuration/code changes.
- [x] Matrix SARVAM UCS recording flow now supports pushing newly generated recordings into the backend DB workflow.
- [x] Backup / Restore button issue was fixed.
- [x] Backup generation was failing earlier because the required function call was missing; the function call is now wired correctly.

## Pending Review Before Push

- [ ] Confirm whether the removed `Create Backup` PBX button in `dashboard.html` is intentional.
- [ ] Test the UI manually with real DB recordings:
  - Filter by `2024-08-17` for `205_17082024_153054_CT_205_09011074842.wav`.
  - Filter by time around `15:30`.
  - Filter by `09011074842`.
  - Filter by `+919545073545`.
- [ ] Confirm older DB rows display filename-derived call date instead of backup/sync date after opening the DB folder.
- [ ] Confirm Store DB still copies files correctly into `backend/pbx_recordings/<snapshot>/<extension>/`.
- [ ] Confirm duplicate handling is acceptable:
  - Same original filename updates DB metadata/path.
  - Same filename in one scan is counted as duplicate.
- [ ] Decide whether DB backfill should process more than 5000 rows per folder if a folder can exceed that size.

## Verification Already Run

- [x] `node --check backend\routes\pbx.js`
- [x] Dashboard script syntax check passed.
- [x] Parser sample verified:
  - `205_17082024_153054_CT_205_09011074842.wav` -> `2024-08-17 15:30:54`, extension `205`, customer `09011074842`
  - `25052026_171842_CT_+919545073545_21.wav` -> `2026-05-25 17:18:42`, extension `21`, customer `+919545073545`

## Suggested Commit Scope

- [ ] Commit app changes separately:
  - `backend/routes/pbx.js`
  - `dashboard.html`
- [ ] Commit PBX diagnostic assets/scripts separately only if they are meant to be preserved in the repo.
- [ ] Do not include temporary/generated PBX screenshots unless needed for troubleshooting history.
