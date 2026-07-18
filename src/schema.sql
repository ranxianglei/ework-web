-- ework schema. Applied idempotently on boot (IF NOT EXISTS everywhere).
-- See db.ts for PRAGMA setup (WAL + foreign_keys = ON).

CREATE TABLE IF NOT EXISTS users (
  login        TEXT PRIMARY KEY,
  kind         TEXT NOT NULL DEFAULT 'human'
               CHECK (kind IN ('human','bot','system')),
  display_name TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner       TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (owner, name)
);

CREATE TABLE IF NOT EXISTS issues (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number     INTEGER NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  state      TEXT NOT NULL DEFAULT 'open'
             CHECK (state IN ('open','closed')),
  author     TEXT NOT NULL REFERENCES users(login),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, number)
);
CREATE INDEX IF NOT EXISTS issues_project_state_updated
  ON issues (project_id, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS issues_state_updated
  ON issues (state, updated_at DESC);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id   INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author     TEXT NOT NULL REFERENCES users(login),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS comments_issue_created
  ON comments (issue_id, created_at);

CREATE TABLE IF NOT EXISTS labels (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#888888',
  UNIQUE (project_id, name)
);

CREATE TABLE IF NOT EXISTS issue_labels (
  issue_id  INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  label_id  INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id, label_id)
);

CREATE TABLE IF NOT EXISTS reactions (
  comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_login TEXT NOT NULL REFERENCES users(login),
  content    TEXT NOT NULL,
  PRIMARY KEY (comment_id, user_login, content)
);
CREATE INDEX IF NOT EXISTS reactions_comment
  ON reactions (comment_id);

CREATE TABLE IF NOT EXISTS attachments (
  uuid        TEXT PRIMARY KEY,
  issue_id    INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size        INTEGER NOT NULL,
  blob_path   TEXT NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES users(login),
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_issue
  ON attachments (issue_id);
