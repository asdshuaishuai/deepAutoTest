/**
 * 0003 · 运行、事件日志（真源）、结果投影、artifact、Agent 会话（06 §2.4–2.8）。
 *
 * 三个刻意设计：
 *  - run_event 主键 (run_id, seq)，不建 at_ms 索引（查询永远按 seq）
 *  - case_result 主键 (run_id, entry_id)：参数化是一等维度
 *  - assert_result 冗余存 expected/actual：快照语义（04 §2.2）
 */

export const name = '0003_runs_and_events';

export const sql = /* sql */ `
CREATE TABLE run (
  id             INTEGER PRIMARY KEY,
  project_id     INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  env_id         INTEGER NOT NULL REFERENCES env(id) ON DELETE RESTRICT,
  policy_json    TEXT    NOT NULL,
  seed           INTEGER NOT NULL,
  status         TEXT    NOT NULL,
  triggered_by   TEXT    NOT NULL,
  started_at_ms  INTEGER NOT NULL,
  finished_at_ms INTEGER,
  event_count    INTEGER NOT NULL,
  chain_hash     TEXT,
  counters_json  TEXT,
  voided         INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_run_project_started ON run(project_id, started_at_ms DESC);

CREATE TABLE run_event (
  run_id   INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  seq      INTEGER NOT NULL,
  at_ms    INTEGER NOT NULL,
  kind     TEXT    NOT NULL,
  entry_id TEXT,
  case_id  INTEGER,
  payload  TEXT    NOT NULL,
  PRIMARY KEY (run_id, seq)
) STRICT;

CREATE TABLE case_result (
  run_id          INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  entry_id        TEXT    NOT NULL,
  case_id         INTEGER NOT NULL REFERENCES test_case(id) ON DELETE CASCADE,
  param_row_label TEXT    NOT NULL,
  intent          TEXT,
  verdict         TEXT    NOT NULL,
  flaky           INTEGER NOT NULL,
  waived          INTEGER NOT NULL,
  overridden_to   TEXT,
  duration_ms     INTEGER NOT NULL,
  attempts        INTEGER NOT NULL,
  failed_asserts  INTEGER NOT NULL,
  seq             INTEGER NOT NULL,
  PRIMARY KEY (run_id, entry_id)
) STRICT;
CREATE INDEX idx_result_run_seq ON case_result(run_id, seq);
CREATE INDEX idx_result_case ON case_result(case_id, run_id);

CREATE TABLE step_result (
  run_id       INTEGER NOT NULL,
  entry_id     TEXT    NOT NULL,
  step_seq     INTEGER NOT NULL,
  kind         TEXT    NOT NULL,
  status       TEXT    NOT NULL,
  duration_ms  INTEGER NOT NULL,
  request_ref  TEXT,
  response_ref TEXT,
  PRIMARY KEY (run_id, entry_id, step_seq)
) STRICT;

CREATE TABLE assert_result (
  run_id        INTEGER NOT NULL,
  entry_id      TEXT    NOT NULL,
  assert_seq    INTEGER NOT NULL,
  step_seq      INTEGER NOT NULL,
  severity      TEXT    NOT NULL,
  expected      TEXT    NOT NULL,
  actual        TEXT    NOT NULL,
  passed        INTEGER NOT NULL,
  principle_id  INTEGER,
  source_file   TEXT,
  source_line   INTEGER,
  PRIMARY KEY (run_id, entry_id, assert_seq)
) STRICT;
CREATE INDEX idx_assert_principle ON assert_result(principle_id);

CREATE TABLE artifact (
  sha256          TEXT    PRIMARY KEY,
  size_bytes      INTEGER NOT NULL,
  content_type    TEXT,
  storage         TEXT    NOT NULL,
  inline_data     BLOB,
  file_path       TEXT,
  truncated       INTEGER NOT NULL,
  original_size   INTEGER,
  created_at_ms   INTEGER NOT NULL,
  retain_until_ms INTEGER
) STRICT;
CREATE INDEX idx_artifact_retain ON artifact(retain_until_ms);

CREATE TABLE agent_session (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  kind          TEXT    NOT NULL,
  checkpoint    BLOB,
  turn_count    INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE agent_turn (
  session_id  INTEGER NOT NULL REFERENCES agent_session(id) ON DELETE CASCADE,
  turn_seq    INTEGER NOT NULL,
  role        TEXT    NOT NULL,
  content     TEXT    NOT NULL,
  tool_name   TEXT,
  tokens_in   INTEGER,
  tokens_out  INTEGER,
  at_ms       INTEGER NOT NULL,
  PRIMARY KEY (session_id, turn_seq)
) STRICT;
`;
