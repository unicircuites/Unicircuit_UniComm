# Outlook Lead Scrape — UniComm Pro

This folder is the **companion package** for the Base44-generated Outlook Lead Extraction model (brain + service).

## Purpose

Automatically detect **sales lead / buyer inquiry emails** from Outlook mail snapshots cached in the CRM, extract structured lead fields with high precision, and insert them into the existing `leads` PostgreSQL table — **without building any frontend**.

## Workflow

1. Send `BASE44_MASTER_PROMPT.md` to **Base44** to generate the model.
2. Place Base44 output in `outlook_lead_scrape/module/`.
3. Send this entire `outlook_lead_scrape/` folder back to the AI agent.
4. The agent wires the service into `backend/server.js` per `INTEGRATION_SPEC.md`.

## Files in this folder

| File | Purpose |
|---|---|
| `BASE44_MASTER_PROMPT.md` | **Send this to Base44** to generate the brain + service module |
| `CURRENT_PIPELINE.md` | Documents existing Outlook mail cache + leads table flow |
| `LEAD_DETECTION_RULES.md` | Domain-specific lead signals for Unicircuit Engineering |
| `INTEGRATION_SPEC.md` | How the Base44 module plugs into the CRM backend |
| `module/` | Base44 model output goes here (created after generation) |

## What this does NOT include

- No dashboard / HTML / UI changes
- No new frontend routes or modals
- No web scraper / Playwright usage
