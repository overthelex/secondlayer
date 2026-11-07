-- One-off backfill of attorney_crm_practice_cases in PHYSICAL order.
--
-- edrsr_fulltext lives on the HDD tablespace and its heap is not in doc_id order
-- (pg_stats correlation −0.18), so the doc_id walk of 001 is one random TOAST read
-- per document: ≈450 reads/s on the disk, ≈20K documents/minute for 24.5M documents.
-- A TID range scan reads the heap and its TOAST chunks in insertion order, which the
-- disk serves sequentially: measured 512 blocks (≈4–8K documents) in 1.3–1.7 s cold,
-- regex included, i.e. 10–12× faster per stream.
--
-- The partition is cut into chunks of p_chunk_blocks heap blocks; chunk c belongs to
-- shard c % p_shards, so several streams over one partition still read adjacent
-- blocks. blocks_total is frozen when the (year, shard) row is created: rows
-- appended later are the daily worker's business (001, adj_date mode).
-- Matching, registry lookup and the upsert are the same as in 001.

CREATE TABLE IF NOT EXISTS attorney_crm_ctid_progress (
  partition_year SMALLINT NOT NULL,
  shard          SMALLINT NOT NULL DEFAULT 0,
  shards         SMALLINT NOT NULL DEFAULT 1,
  chunk_blocks   INTEGER  NOT NULL,
  blocks_total   BIGINT   NOT NULL,
  next_chunk     BIGINT   NOT NULL,
  docs_scanned   BIGINT   NOT NULL DEFAULT 0,
  hits           BIGINT   NOT NULL DEFAULT 0,
  done           BOOLEAN  NOT NULL DEFAULT false,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (partition_year, shard),
  CHECK (shard >= 0 AND shard < shards)
);

CREATE OR REPLACE FUNCTION attorney_crm_derive_ctid_batch(
  p_year         INTEGER,
  p_shard        INTEGER DEFAULT 0,
  p_shards       INTEGER DEFAULT 1,
  p_chunk_blocks INTEGER DEFAULT 512
) RETURNS TABLE (out_docs INTEGER, out_hits INTEGER, out_chunk BIGINT, out_chunks BIGINT)
LANGUAGE plpgsql AS $$
DECLARE
  v_rel      TEXT := format('edrsr_fulltext_p_%s', p_year);
  v_from     TIMESTAMPTZ := make_timestamptz(p_year, 1, 1, 0, 0, 0, 'Europe/Kyiv') - interval '2 days';
  v_to       TIMESTAMPTZ := make_timestamptz(p_year + 1, 1, 1, 0, 0, 0, 'Europe/Kyiv') + interval '2 days';
  v_blocks   BIGINT;
  v_chunk    BIGINT;
  v_k        INTEGER;
  v_shards   INTEGER;
  v_chunks   BIGINT;
  v_lo       TID;
  v_hi       TID;
  v_docs     INTEGER := 0;
  v_hits     INTEGER := 0;
BEGIN
  INSERT INTO attorney_crm_ctid_progress (partition_year, shard, shards, chunk_blocks, blocks_total, next_chunk)
  SELECT p_year, p_shard, p_shards, p_chunk_blocks, pg_relation_size(v_rel::regclass) / current_setting('block_size')::int, p_shard
  ON CONFLICT (partition_year, shard) DO NOTHING;

  SELECT pr.blocks_total, pr.next_chunk, pr.chunk_blocks, pr.shards
    INTO v_blocks, v_chunk, v_k, v_shards
    FROM attorney_crm_ctid_progress pr
   WHERE pr.partition_year = p_year AND pr.shard = p_shard FOR UPDATE;
  IF v_shards <> p_shards THEN
    RAISE EXCEPTION 'attorney_crm_derive_ctid_batch: year % shard % was created with % shards, called with %', p_year, p_shard, v_shards, p_shards;
  END IF;
  v_chunks := (v_blocks + v_k - 1) / v_k;

  IF v_chunk >= v_chunks THEN
    UPDATE attorney_crm_ctid_progress SET done = true, updated_at = NOW()
     WHERE partition_year = p_year AND shard = p_shard;
    RETURN QUERY SELECT 0, 0, v_chunk, v_chunks;
    RETURN;
  END IF;

  v_lo := format('(%s,0)', v_chunk * v_k)::tid;
  v_hi := format('(%s,0)', (v_chunk + 1) * v_k)::tid;

  EXECUTE format($q$
    WITH texts AS (
      SELECT f.doc_id, d.justice_kind, d.category_code, d.cause_num,
             extract(year FROM d.adjudication_date AT TIME ZONE 'Europe/Kyiv')::smallint AS yr,
             f.full_text
      FROM %I f
      JOIN edrsr_documents d ON d.doc_id = f.doc_id
                            AND d.adjudication_date >= $1 AND d.adjudication_date < $2
      WHERE f.ctid >= $3 AND f.ctid < $4
        AND d.cause_num IS NOT NULL AND d.cause_num <> ''
    ),
    counted AS (SELECT count(*) AS n FROM texts),
    mentions AS (
      SELECT t.doc_id, t.justice_kind, t.category_code, t.cause_num, t.yr,
             lower(g[1]) AS sur, lower(g[2]) AS fn, lower(g[3]) AS pn
      FROM texts t,
           regexp_matches(t.full_text,
             '[Аа]двокат(?:а|ом|у|ові|ів|ка|ки|кою|ці)?\s+([А-ЯІЇЄҐ][а-яіїєґ''’-]+)\s+([А-ЯІЇЄҐ][а-яіїєґ''’-]+)\s+([А-ЯІЇЄҐ][а-яіїєґ''’-]+)',
             'g') AS g
    ),
    matched AS (
      SELECT m.*, s.ids[1] AS source_id
      FROM mentions m
      CROSS JOIN LATERAL (
        SELECT array_agg(source_id) AS ids FROM (
          SELECT source_id FROM attorney_crm_advocate_stems st
          WHERE st.fam_l  LIKE left(m.sur, greatest(length(m.sur) - 2, 3)) || '%%'
            AND st.name_l LIKE left(m.fn,  greatest(length(m.fn)  - 2, 3)) || '%%'
            AND st.pat_l  LIKE left(m.pn,  greatest(length(m.pn)  - 3, 4)) || '%%'
          LIMIT 2
        ) two
      ) s
      WHERE cardinality(s.ids) = 1
    ),
    upserted AS (
      INSERT INTO attorney_crm_practice_cases AS c
        (advocate_source_id, cause_num, justice_kind, category_code, decisions, first_year, last_year)
      SELECT source_id, cause_num, min(justice_kind), min(category_code),
             count(DISTINCT doc_id), min(yr), max(yr)
      FROM matched
      GROUP BY source_id, cause_num
      ON CONFLICT (advocate_source_id, cause_num) DO UPDATE SET
        decisions  = c.decisions + EXCLUDED.decisions,
        first_year = LEAST(c.first_year, EXCLUDED.first_year),
        last_year  = GREATEST(c.last_year, EXCLUDED.last_year),
        justice_kind  = COALESCE(c.justice_kind, EXCLUDED.justice_kind),
        category_code = COALESCE(c.category_code, EXCLUDED.category_code)
      RETURNING 1
    )
    SELECT (SELECT n FROM counted)::int, (SELECT count(*) FROM upserted)::int
  $q$, v_rel)
  INTO v_docs, v_hits
  USING v_from, v_to, v_lo, v_hi;

  UPDATE attorney_crm_ctid_progress
     SET next_chunk = v_chunk + p_shards, docs_scanned = docs_scanned + v_docs,
         hits = hits + v_hits, updated_at = NOW()
   WHERE partition_year = p_year AND shard = p_shard;

  RETURN QUERY SELECT v_docs, v_hits, v_chunk, v_chunks;
END $$;
