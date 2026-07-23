-- sync_runs 承载每日候选生成任务：kind 放宽为 fx_rates / candidate_generation（重建以替换 CHECK）。
CREATE TABLE sync_runs_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('fx_rates', 'candidate_generation')),
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed', 'schema_drift')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  error_code TEXT,
  detail_json TEXT
);
INSERT INTO sync_runs_new (id, kind, status, started_at, finished_at, error_code, detail_json)
SELECT id, 'fx_rates', status, started_at, finished_at, error_code, detail_json FROM sync_runs;
DROP TABLE sync_runs;
ALTER TABLE sync_runs_new RENAME TO sync_runs;
