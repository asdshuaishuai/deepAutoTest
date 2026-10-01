/**
 * 0001 · 项目域（06 §2.1）—— P5 隔离的根。
 * 删除项目级联清理其下一切；但删除前应完整备份（上层职责，store 只保证不残留）。
 */

export const name = '0001_project_domain';

export const sql = /* sql */ `
CREATE TABLE project (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL,
  source_type   TEXT    NOT NULL,
  repo_url      TEXT,
  local_path    TEXT,
  git_ref       TEXT,
  status        TEXT    NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE env (
  id               INTEGER PRIMARY KEY,
  project_id       INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name             TEXT    NOT NULL,
  base_url         TEXT    NOT NULL,
  variables        TEXT    NOT NULL,
  secret_names     TEXT    NOT NULL,
  headers          TEXT    NOT NULL,
  allow_self_signed INTEGER NOT NULL,
  created_at_ms    INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_env_project ON env(project_id);

CREATE TABLE db_connection (
  id             INTEGER PRIMARY KEY,
  project_id     INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name           TEXT    NOT NULL,
  dialect        TEXT    NOT NULL,
  dsn_encrypted  BLOB    NOT NULL,
  read_only      INTEGER NOT NULL,
  created_at_ms  INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_dbconn_project ON db_connection(project_id);
`;
