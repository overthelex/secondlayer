-- Migration 267: the migration 227 list prices at the current NBU rate.
--
-- Migration 227 set the MCP v2 tool prices in UAH and stored them in USD at
-- 41,5 грн/$. Tool charges come out of the USD balance, and UAH top-ups convert
-- at the live NBU rate (45,4274 on 14.11.2026), so every one of those prices was
-- ~9,5% above its UAH list price (0,50 грн charged as 0,55; 1,00 as 1,10).
-- Rescale them to the same UAH at 45,4274. Only the rows 227 set and nothing has
-- changed since are touched (updated_by = migration_227), so a manual price is
-- left alone and re-running is a no-op. Prices designed in USD (176, the 10x
-- cut, manual edits) do not depend on the rate and are not changed.
UPDATE tool_pricing
SET base_cost_usd = round(base_cost_usd * 41.5 / 45.4274, 8),
    notes = trim(both ' ' from coalesce(notes, '') || ' (курс НБУ 45,4274, 14.11.2026)'),
    updated_at = NOW(),
    updated_by = 'migration_267'
WHERE updated_by = 'migration_227';
