-- Article split of PDF-only Polish snapshots (verdict 906), scripts/pl/segment_eli_pdf.py.
-- NULL = not tried yet, 200 = split into pl_act_articles / pl_act_units,
-- 9xx = rejected by pl_pdf_segmenter (whole text kept, article_count stays 0).
ALTER TABLE pl_snapshot_texts ADD COLUMN IF NOT EXISTS pdf_split SMALLINT;

CREATE INDEX IF NOT EXISTS idx_pl_snapshot_texts_pdf_todo
    ON pl_snapshot_texts (snapshot_eli) WHERE http_status = 906 AND pdf_split IS NULL;
