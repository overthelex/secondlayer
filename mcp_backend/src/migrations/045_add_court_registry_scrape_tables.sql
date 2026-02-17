-- LEG-53: Court Registry scrape checkpoint, queue, and stats
-- Checkpoint для скрапинга court registry
CREATE TABLE IF NOT EXISTS court_registry_scrape_checkpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scrape_config_hash VARCHAR(64) NOT NULL,
  justice_kind VARCHAR(100) NOT NULL,
  doc_form VARCHAR(100) NOT NULL,
  search_text TEXT,
  date_from VARCHAR(20) NOT NULL,
  last_page INTEGER NOT NULL DEFAULT 0,
  last_scraped_at TIMESTAMP,
  documents_scraped INTEGER NOT NULL DEFAULT 0,
  documents_failed INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(50) NOT NULL DEFAULT 'in_progress',
  error_message TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(scrape_config_hash)
);

CREATE INDEX IF NOT EXISTS idx_court_registry_checkpoint_config
  ON court_registry_scrape_checkpoints(scrape_config_hash);
CREATE INDEX IF NOT EXISTS idx_court_registry_checkpoint_status
  ON court_registry_scrape_checkpoints(status);

-- Очередь URL для queue-based архитектуры
CREATE TABLE IF NOT EXISTS court_registry_scrape_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id VARCHAR(50) NOT NULL UNIQUE,
  url TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  checkpoint_id UUID REFERENCES court_registry_scrape_checkpoints(id) ON DELETE SET NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  scraped_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scrape_queue_status ON court_registry_scrape_queue(status);
CREATE INDEX IF NOT EXISTS idx_scrape_queue_checkpoint ON court_registry_scrape_queue(checkpoint_id);
CREATE INDEX IF NOT EXISTS idx_scrape_queue_doc_id ON court_registry_scrape_queue(doc_id);

-- Статистика для мониторинга и алертов
CREATE TABLE IF NOT EXISTS court_registry_scrape_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id VARCHAR(64) NOT NULL,
  checkpoint_id UUID REFERENCES court_registry_scrape_checkpoints(id) ON DELETE SET NULL,
  success_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  captcha_count INTEGER NOT NULL DEFAULT 0,
  block_count INTEGER NOT NULL DEFAULT 0,
  duration_sec FLOAT,
  success_rate FLOAT,
  recorded_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scrape_stats_run ON court_registry_scrape_stats(run_id);
CREATE INDEX IF NOT EXISTS idx_scrape_stats_recorded ON court_registry_scrape_stats(recorded_at);

-- updated_at triggers (same pattern as other tables)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_court_registry_checkpoint_updated_at') THEN
    CREATE TRIGGER update_court_registry_checkpoint_updated_at
      BEFORE UPDATE ON court_registry_scrape_checkpoints
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_court_registry_queue_updated_at') THEN
    CREATE TRIGGER update_court_registry_queue_updated_at
      BEFORE UPDATE ON court_registry_scrape_queue
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
