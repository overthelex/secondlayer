-- 018: Crash-safe index restore for the "huge" CSV import path.
--
-- importCsv drops a table's indexes before a bulk load and recreates them
-- afterwards, holding the definitions only in process memory. If the process
-- dies in between (container restart mid-import, OOM, deploy), the definitions
-- are gone: the next run's dropIndexes finds nothing to save, the
-- savedIndexes.length > 0 guard skips the rebuild, and the table is left
-- permanently unindexed. This happened to enforcement_proceedings — a deploy
-- restarted the container mid-import and every index except the pkey was lost.
--
-- Definitions are now written here before the drop and cleared only after a
-- successful recreate, so a crashed run leaves a durable repair record.

CREATE TABLE IF NOT EXISTS csv_import_saved_indexes (
  id SERIAL PRIMARY KEY,
  table_name VARCHAR(255) NOT NULL,
  index_name VARCHAR(255) NOT NULL,
  index_def TEXT NOT NULL,
  is_constraint BOOLEAN NOT NULL DEFAULT false,
  constraint_type CHAR(1),
  saved_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (table_name, index_name)
);

CREATE INDEX IF NOT EXISTS idx_csv_import_saved_indexes_table
  ON csv_import_saved_indexes(table_name);
