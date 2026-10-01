/**
 * DSN 加密存储（08 §5.4 的本地兜底路径）。
 *
 * ★ 诚实标注保护级别（设计红线「不静默降级」）：主密钥是 dataDir 下的随机
 * keyfile（0600）——**受文件权限保护，不是系统钥匙串**。上层 UI 必须如实
 * 显示「受文件权限保护（非系统钥匙串）」。接入 macOS `security` CLI 是
 * 后续增强，接口不变。
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { KernelError } from '../shared/util.ts';

const KEY_FILE = 'secret.key';

function loadOrCreateKey(dataDir: string): Buffer {
  const path = join(dataDir, KEY_FILE);
  if (existsSync(path)) {
    const key = readFileSync(path);
    if (key.length !== 32) throw new KernelError('secret_key_corrupt', '密钥文件损坏（长度不符），无法解密凭据');
    return key;
  }
  const key = randomBytes(32);
  writeFileSync(path, key, { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}

export function encryptSecret(dataDir: string, plaintext: string): Buffer {
  const key = loadOrCreateKey(dataDir);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

export function decryptSecret(dataDir: string, blob: Uint8Array): string {
  const key = loadOrCreateKey(dataDir);
  const buf = Buffer.from(blob);
  if (buf.length < 12 + 16) throw new KernelError('dsn_corrupt', 'DSN 密文过短，无法解密');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    throw new KernelError('dsn_decrypt_failed', 'DSN 解密失败（密文或密钥不匹配）');
  }
}
