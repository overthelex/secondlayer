# LEG-53: Court Registry Scrape — Implementation Summary

## Done

- **Checkpoint** — `court_registry_scrape_checkpoints`: last page, last_scraped_at (only on completed/failed), status.
- **Incremental** — `INCREMENTAL=true`: scrape from day after last successful run (last_scraped_at). Hash excludes dateFrom so same config finds same checkpoint.
- **Resume** — `RESUME=true`: start from checkpoint.last_page + 1. Direct page nav via `tryGoToPageDirect()` with verification; fallback click-through. On CAPTCHA during resume, startPage is set to actual page so we don’t continue on wrong page.
- **Anti-detection** — Random delays, User-Agent rotation (Chrome/Firefox 133). UA rotated per tab in `downloadDecisionDirect`.
- **CAPTCHA/block** — waitForCaptcha, webhook alert, checkpoint saved as failed, throw for cleanup.
- **Proxy** — `SCRAPE_PROXY` / `HTTP_PROXY` passed to `chromium.launch()`.
- **Metrics** — Counters (scrape total, captcha, block), Gauge (success rate). No HTTP /metrics (script exits); pushgateway can be added later.
- **Migration** — `044_add_court_registry_scrape_tables.sql`: checkpoints, queue (for future), stats, updated_at triggers.

## Env vars

| Var | Description |
|-----|-------------|
| `INCREMENTAL` | `true` — scrape from last run date |
| `RESUME` | `true` — resume from checkpoint page |
| `SCRAPE_PROXY` | HTTP proxy for browser |
| `SCRAPE_ALERT_WEBHOOK` | Webhook for CAPTCHA/block alerts |
| `SCRAPE_DELAY_MIN_MS` / `SCRAPE_DELAY_MAX_MS` | Delay range between requests |

## Run

```bash
cd mcp_backend && npm run migrate
npm run scrape:court
INCREMENTAL=true RESUME=true npm run scrape:court
```

## Queue-based (follow-up)

Table `court_registry_scrape_queue` and `enqueueUrls()` are in place. Discovery (fill queue) and extraction (workers) to be implemented separately.
