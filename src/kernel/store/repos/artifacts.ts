/**
 * Artifact 仓储（06 §2.7）：sha256 主键天然去重；小对象内联，大对象落文件。
 *
 * 顺序纪律（03 §5.2）：artifact 必须先于引用它的事件落盘。
 * 本模块自身完成"写文件 + 插行"，调用方随后在事件里引用返回的 ref。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Db } from '../db.ts';
import { KernelError, sha256Hex } from '../../shared/util.ts';

export const INLINE_MAX_BYTES = 64 * 1024;
/** 超过此值的大对象只保留前 64 KiB + sha256（04 §7.1）。 */
export const TRUNCATE_MAX_BYTES = 10 * 1024 * 1024;

export interface PutArtifactResult {
  sha256: string;
  sizeBytes: number;
  truncated: boolean;
  originalSize: number;
}

export function putArtifact(
  db: Db,
  artifactsDir: string,
  content: Buffer,
  contentType: string | null,
  nowMs: number,
): PutArtifactResult {
  const originalSize = content.length;
  let stored = content;
  let truncated = false;
  if (originalSize > TRUNCATE_MAX_BYTES) {
    stored = content.subarray(0, TRUNCATE_MAX_BYTES);
    truncated = true;
  }
  const sha = sha256Hex(stored.toString('binary'));

  const existing = db.prepare('SELECT sha256 FROM artifact WHERE sha256 = ?').get(sha);
  if (existing !== undefined) {
    return { sha256: sha, sizeBytes: stored.length, truncated, originalSize };
  }

  if (stored.length <= INLINE_MAX_BYTES) {
    db.prepare(
      `INSERT INTO artifact (sha256, size_bytes, content_type, storage, inline_data, file_path, truncated, original_size, created_at_ms)
       VALUES (?, ?, ?, 'inline', ?, NULL, ?, ?, ?)`,
    ).run(sha, stored.length, contentType, new Uint8Array(stored), truncated ? 1 : 0, originalSize, nowMs);
  } else {
    const abs = join(artifactsDir, sha);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, stored);
    db.prepare(
      `INSERT INTO artifact (sha256, size_bytes, content_type, storage, inline_data, file_path, truncated, original_size, created_at_ms)
       VALUES (?, ?, ?, 'file', NULL, ?, ?, ?, ?)`,
    ).run(sha, stored.length, contentType, sha, truncated ? 1 : 0, originalSize, nowMs);
  }
  return { sha256: sha, sizeBytes: stored.length, truncated, originalSize };
}

export interface StoredArtifact {
  sha256: string;
  contentType: string | null;
  content: Buffer;
  truncated: boolean;
  originalSize: number;
}

export function getArtifact(db: Db, artifactsDir: string, sha256: string): StoredArtifact {
  const row = db.prepare('SELECT * FROM artifact WHERE sha256 = ?').get(sha256) as
    | {
        sha256: string;
        content_type: string | null;
        storage: string;
        inline_data: Uint8Array | null;
        file_path: string | null;
        truncated: number;
        original_size: number | null;
      }
    | undefined;
  if (row === undefined) throw new KernelError('not_found', `artifact ${sha256} 不存在`);

  const content =
    row.storage === 'inline'
      ? Buffer.from(row.inline_data ?? new Uint8Array(0))
      : readFileSync(join(artifactsDir, row.file_path!));

  // 完整性：artifact 也按内容哈希寻址，读回时验证
  if (sha256Hex(content.toString('binary')) !== sha256) {
    throw new KernelError('artifact_hash_mismatch', `artifact ${sha256} 内容与哈希不符（文件损坏）`);
  }
  return {
    sha256: row.sha256,
    contentType: row.content_type,
    content,
    truncated: row.truncated === 1,
    originalSize: row.original_size ?? content.length,
  };
}

export function hashContent(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}
