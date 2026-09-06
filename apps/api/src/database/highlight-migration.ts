export const EPISODE_HIGHLIGHT_MIGRATION = `
CREATE TABLE episode_highlights (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  source_content TEXT NOT NULL,
  canon_snapshot_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED')),
  is_current INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  run_id TEXT REFERENCES ai_runs(id) ON DELETE SET NULL,
  plan_json TEXT,
  provider_result_json TEXT,
  file_name TEXT,
  mime_type TEXT,
  anchor_source_content TEXT,
  anchor_text TEXT,
  anchor_offset INTEGER,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(episode_id, idempotency_key)
);
CREATE INDEX idx_highlights_project ON episode_highlights(project_id, episode_id);
CREATE UNIQUE INDEX idx_highlights_current ON episode_highlights(episode_id) WHERE is_current = 1;
CREATE UNIQUE INDEX idx_highlights_running ON episode_highlights(episode_id) WHERE status = 'RUNNING';

-- File removal is queued transactionally with cascades, so a restart between
-- deleting a novel and unlinking its images cannot orphan the stored files.
CREATE TABLE highlight_file_cleanup (file_name TEXT PRIMARY KEY);
CREATE TRIGGER highlight_delete_file AFTER DELETE ON episode_highlights
WHEN OLD.file_name IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO highlight_file_cleanup(file_name) VALUES (OLD.file_name);
END;
CREATE TRIGGER highlight_replace_file AFTER UPDATE OF file_name ON episode_highlights
WHEN OLD.file_name IS NOT NULL AND (NEW.file_name IS NULL OR NEW.file_name != OLD.file_name)
BEGIN
  INSERT OR IGNORE INTO highlight_file_cleanup(file_name) VALUES (OLD.file_name);
END;
`;
