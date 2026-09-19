-- 000: the extensions the schema depends on but nothing installed.
--
-- Found on 2026-09-19 while proving that a database can be built from these
-- migrations alone. 195_uk_legislation.sql creates a trigram index on act
-- titles:
--
--     CREATE INDEX idx_uk_leg_title_trgm ON uk_legislation USING gin (title gin_trgm_ops)
--
-- and against a fresh database that fails with `operator class "gin_trgm_ops"
-- does not exist for access method "gin"`. Production has pg_trgm because
-- somebody once ran CREATE EXTENSION by hand; the migration history never did,
-- so every new deployment inherited the gap silently — and an automated
-- bootstrap "converged" by dropping the UK migration rather than the cause.
--
-- pgcrypto and uuid-ossp are created by later migrations already; naming them
-- here too costs nothing and stops the order from mattering.
--
-- ⚠ dblink is in production and is NOT here. Nothing in the UK schema uses it,
-- and it is a privileged extension worth adding deliberately rather than by
-- inheritance.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
