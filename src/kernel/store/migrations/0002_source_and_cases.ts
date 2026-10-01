/**
 * 0002 · 源码索引、API 候选、原则库、测试用例（06 §2.2–2.4）。
 * 基座先建全 schema（迁移只增不改），route/principle 的提取器是后续层。
 */

export const name = '0002_source_and_cases';

export const sql = /* sql */ `
CREATE TABLE source_index (
  id             INTEGER PRIMARY KEY,
  project_id     INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  git_ref        TEXT,
  file_count     INTEGER NOT NULL,
  frameworks     TEXT    NOT NULL,
  indexed_at_ms  INTEGER NOT NULL
) STRICT;

CREATE TABLE route_candidate (
  id              INTEGER PRIMARY KEY,
  project_id      INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  source_index_id INTEGER NOT NULL REFERENCES source_index(id) ON DELETE CASCADE,
  method          TEXT    NOT NULL,
  path            TEXT    NOT NULL,
  handler_file    TEXT    NOT NULL,
  handler_line    INTEGER NOT NULL,
  framework       TEXT    NOT NULL,
  confidence      TEXT    NOT NULL,
  status          TEXT    NOT NULL,
  doc_drift       INTEGER NOT NULL,
  doc_missing     INTEGER NOT NULL,
  proposed_by     TEXT,
  reviewed_by     TEXT,
  reviewed_at_ms  INTEGER,
  diff            TEXT
) STRICT;
CREATE INDEX idx_route_project_status ON route_candidate(project_id, status);

CREATE TABLE principle (
  id             INTEGER PRIMARY KEY,
  project_id     INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  subject        TEXT    NOT NULL,
  rule           TEXT    NOT NULL,
  value_json     TEXT,
  source_file    TEXT    NOT NULL,
  source_line    INTEGER NOT NULL,
  layer          TEXT    NOT NULL,
  confidence     TEXT    NOT NULL,
  status         TEXT    NOT NULL,
  conflict_json  TEXT,
  proposed_by    TEXT,
  reviewed_by    TEXT,
  reviewed_at_ms INTEGER,
  diff           TEXT
) STRICT;
CREATE INDEX idx_principle_project ON principle(project_id, status);
CREATE INDEX idx_principle_subject ON principle(project_id, subject);

CREATE TABLE test_case (
  id               INTEGER PRIMARY KEY,
  project_id       INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  route_id         INTEGER REFERENCES route_candidate(id) ON DELETE SET NULL,
  name             TEXT    NOT NULL,
  description      TEXT,
  status           TEXT    NOT NULL,
  param_kind       TEXT    NOT NULL,
  steps_json       TEXT    NOT NULL,
  params_json      TEXT    NOT NULL,
  provenance_json  TEXT    NOT NULL,
  policy_json      TEXT,
  tags             TEXT    NOT NULL,
  proposed_by      TEXT    NOT NULL,
  reviewed_by      TEXT,
  reviewed_at_ms   INTEGER,
  diff             TEXT,
  created_at_ms    INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_case_project_status ON test_case(project_id, status);
`;
