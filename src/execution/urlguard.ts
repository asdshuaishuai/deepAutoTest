/**
 * urlguard —— SSRF 分档防护（08 §2）。
 *
 * 同一个"私有地址"在两个方向答案相反：
 *  - strict（源码/仓库/文档出站抓取）：默认拒绝私有/环回/链路本地/保留网段，**不可配置放宽**
 *  - permissive（测试执行目标）：默认允许——产品定位就是测内网，不允许就完全不可用
 *
 * 实现要点：DNS 解析后**逐 IP** 校验（不是只看域名）。
 * 已知边界（诚实声明）：当前在请求前校验，未在连接层钉死已校验 IP（防 DNS rebinding 的
 * TOCTOU 完整闭环需要自定义 connector），威胁模型是误操作而非对手（08 §1），此残余风险
 * 记录在案，待执行层接入 worker 池时一并加固。
 */

import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export type UrlGuardMode = 'strict' | 'permissive';

export interface UrlCheckResult {
  ok: boolean;
  reason: string | null;
  /** 解析得到的全部 IP（诊断用）。 */
  ips: string[];
}

export async function checkUrl(rawUrl: string, mode: UrlGuardMode): Promise<UrlCheckResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid_url', ips: [] };
  }

  // 仅允许 http/https（拒绝 file:// ftp:// gopher:// data:）
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'protocol_denied', ips: [] };
  }

  const ips = await resolveIps(url.hostname);
  if (ips.length === 0) return { ok: false, reason: 'dns_failed', ips };

  if (mode === 'permissive') return { ok: true, reason: null, ips };

  for (const ip of ips) {
    const bad = privateRange(ip);
    if (bad !== null) return { ok: false, reason: bad, ips };
  }
  return { ok: true, reason: null, ips };
}

async function resolveIps(hostname: string): Promise<string[]> {
  // 字面 IP 直接返回
  if (isIP(hostname) !== 0) return [hostname];
  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return records.map((r) => r.address);
  } catch {
    return [];
  }
}

/** 返回命中的拒绝网段名；公网返回 null。 */
export function privateRange(ip: string): string | null {
  const [ipVer] = isIP(ip) === 6 ? ([6] as const) : ([4] as const);
  if (ipVer === 4) {
    const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return 'invalid_ip';
    const [a, b] = parts as [number, number, number, number];
    if (a === 127) return 'loopback'; // 127.0.0.0/8
    if (a === 10) return 'private'; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return 'private'; // 172.16.0.0/12
    if (a === 192 && b === 168) return 'private'; // 192.168.0.0/16
    if (a === 169 && b === 254) return 'link_local'; // ★ 云元数据 169.254.169.254
    if (a === 0) return 'reserved'; // 0.0.0.0/8
    if (a >= 224) return 'reserved'; // 组播 + 保留
    return null;
  }
  // IPv6
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return 'loopback';
  if (lower.startsWith('fe80')) return 'link_local';
  if (lower.startsWith('fc') || lower.startsWith('fd')) return 'unique_local'; // fc00::/7
  return null;
}
