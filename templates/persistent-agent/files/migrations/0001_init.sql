CREATE TABLE IF NOT EXISTS agent_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_events_created_at
  ON agent_events(created_at DESC);
