import * as m0001 from './0001_project_domain.ts';
import * as m0002 from './0002_source_and_cases.ts';
import * as m0003 from './0003_runs_and_events.ts';

export interface Migration {
  name: string;
  sql: string;
}

/** 只增不改：新迁移只能追加在尾部（06 §1.1）。 */
export const MIGRATIONS: readonly Migration[] = [
  { name: m0001.name, sql: m0001.sql },
  { name: m0002.name, sql: m0002.sql },
  { name: m0003.name, sql: m0003.sql },
];
