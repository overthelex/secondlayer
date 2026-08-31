\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS ae_legislation_articles (
    article_id     text PRIMARY KEY,
    law_id         int NOT NULL,
    material_id    int,            -- the portal's own id; what amendments key on
    seq            int,
    chapter        text,
    article_label  text,
    article_no     text,
    text           text,
    has_previous   boolean,        -- the act's own marker that this article was amended
    content_sha256 text,
    imported_at    timestamptz DEFAULT now(),
    updated_at     timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ae_art_law ON ae_legislation_articles (law_id, seq);
CREATE INDEX IF NOT EXISTS idx_ae_art_no ON ae_legislation_articles (law_id, article_no);
CREATE INDEX IF NOT EXISTS idx_ae_art_material ON ae_legislation_articles (material_id);
CREATE INDEX IF NOT EXISTS idx_ae_art_amended ON ae_legislation_articles (has_previous)
    WHERE has_previous;
CREATE INDEX IF NOT EXISTS idx_ae_art_fts_ar ON ae_legislation_articles
    USING gin (to_tsvector('arabic', coalesce(article_label, '') || ' ' || coalesce(text, '')))
    WHERE text IS NOT NULL;

DROP TABLE IF EXISTS ae_stage_art;
CREATE TABLE ae_stage_art(j jsonb);
\copy ae_stage_art(j) FROM '/tmp/leg_articles.jsonl' WITH (FORMAT csv, QUOTE E'\x01', DELIMITER E'\x02')
SELECT count(*) AS staged FROM ae_stage_art;

INSERT INTO ae_legislation_articles (article_id, law_id, material_id, seq, chapter,
        article_label, article_no, text, has_previous, content_sha256)
SELECT DISTINCT ON (j->>'article_id')
    j->>'article_id', (j->>'law_id')::int, NULLIF(j->>'material_id','')::int,
    NULLIF(j->>'seq','')::int, j->>'chapter', j->>'article_label', j->>'article_no',
    j->>'text', (j->>'has_previous')::boolean, j->>'content_sha256'
FROM ae_stage_art
ORDER BY j->>'article_id', length(j->>'text') DESC NULLS LAST
ON CONFLICT (article_id) DO UPDATE SET
    text = EXCLUDED.text, article_label = EXCLUDED.article_label,
    chapter = EXCLUDED.chapter, has_previous = EXCLUDED.has_previous,
    content_sha256 = EXCLUDED.content_sha256, updated_at = now();
DROP TABLE ae_stage_art;

\echo '=== articles ==='
SELECT count(*) AS articles, count(DISTINCT law_id) AS acts,
       count(*) FILTER (WHERE has_previous) AS marked_amended,
       count(chapter) AS with_chapter,
       pg_size_pretty(sum(length(text))::bigint) AS text_volume
FROM ae_legislation_articles;

\echo '=== coverage against the act-level corpus ==='
SELECT count(*) AS acts_total,
       count(*) FILTER (WHERE a.law_id IS NOT NULL) AS acts_with_articles
FROM ae_legislation l
LEFT JOIN (SELECT DISTINCT law_id FROM ae_legislation_articles) a USING (law_id);

\echo '=== articles per act ==='
SELECT CASE WHEN n <= 10 THEN '1-10' WHEN n <= 50 THEN '11-50'
            WHEN n <= 200 THEN '51-200' ELSE '200+' END AS bucket, count(*) AS acts
FROM (SELECT law_id, count(*) AS n FROM ae_legislation_articles GROUP BY 1) t
GROUP BY 1 ORDER BY min(n);

\echo '=== does the per-article amendment marker agree with the amendment tables? ==='
SELECT count(*) FILTER (WHERE a.has_previous) AS marked_by_the_act,
       count(*) FILTER (WHERE c.article_id IS NOT NULL) AS matched_a_recorded_change
FROM ae_legislation_articles a
LEFT JOIN (SELECT DISTINCT law_id, article_no,
                  'x' AS article_id FROM ae_legislation_article_changes) c
       ON c.law_id = a.law_id AND c.article_no = a.article_no
WHERE a.has_previous;
