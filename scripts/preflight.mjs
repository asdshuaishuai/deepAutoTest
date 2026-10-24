// Node 版本闸 + 启动器：本项目需要 Node 22+（node:sqlite / 类型剥离）。
//
// 用法：node scripts/preflight.mjs -- <command...>
//   - 当前 Node ≥ 22：直接执行 <command>。
//   - 当前 Node < 22：找到本机已装的 Node 22+（优先级：PREFLIGHT_NODE 显式
//     指定 > .nvmrc 指定版本 > 最高已装版本），把它的 bin 目录插到 PATH 最前，
//     以它重跑本脚本并由其执行 <command>——保证 vitest / tsc / demo 真正跑在
//     Node 22 上。找不到 Node 22+ 时报错退出。
//   - 无 `--` 参数：仅做版本自检（npm run preflight）。
//
// 注意：不要把本脚本挂成 npm 的 pre 钩子去"替跑"主脚本。npm 在 pre 钩子
// 退出 0 后，仍会用外层（旧 Node）环境把主脚本原样再跑一遍——主脚本会执行
// 两次，第二次在 Node 20 下必挂（node:sqlite 不存在，套件级收集失败）。
// package.json 的脚本统一通过 `node scripts/preflight.mjs -- <cmd>` 启动。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = dirname(dirname(scriptPath));

// `--` 之后的参数是要执行的命令。
const sep = process.argv.indexOf('--');
const command = sep !== -1 ? process.argv.slice(sep + 1) : [];

// 定位一个 Node 22+ 二进制。
function findNode22() {
  const override = process.env.PREFLIGHT_NODE;
  if (override && existsSync(override)) return override;

  const nvmDir = process.env.NVM_DIR || join(process.env.HOME ?? '', '.nvm');
  const versionsDir = join(nvmDir, 'versions', 'node');
  if (!existsSync(versionsDir)) return null;

  const dirs = readdirSync(versionsDir)
    .filter((d) => /^v(2[2-9]|[3-9]\d)\./.test(d))
    .sort()
    .reverse();
  if (dirs.length === 0) return null;

  let pinned = '';
  try {
    pinned = readFileSync(join(projectRoot, '.nvmrc'), 'utf8').trim().replace(/^v/, '');
  } catch {
    // 无 .nvmrc 或不可读：退回最高版本。
  }
  const preferred = pinned ? dirs.find((d) => d.slice(1).startsWith(pinned)) : undefined;
  const chosen = preferred ?? dirs[0];
  const bin = join(versionsDir, chosen, 'bin', 'node');
  return existsSync(bin) ? bin : null;
}

const version = process.versions.node;
const major = Number.parseInt(version.split('.')[0] ?? '0', 10);

if (major >= 22) {
  if (command.length === 0) process.exit(0);
  const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit' });
  if (result.error) console.error(`  [preflight] 执行失败：${String(result.error)}`);
  process.exit(result.status ?? 1);
}

const nodeBin = findNode22();
if (nodeBin && !process.env.PREFLIGHT_REEXECED) {
  console.error(`  [preflight] 当前 v${version} < 22，自动切换到 ${nodeBin} 重跑。`);
  const result = spawnSync(nodeBin, [scriptPath, '--', ...command], {
    stdio: 'inherit',
    env: {
      ...process.env,
      PREFLIGHT_REEXECED: '1',
      PATH: `${dirname(nodeBin)}:${process.env.PATH ?? ''}`,
    },
  });
  if (result.error) console.error(`  [preflight] 重跑失败：${String(result.error)}`);
  process.exit(result.status ?? 1);
}

console.error(
  [
    '',
    `  ✗ 需要 Node 22+（当前 v${version}）。`,
    '    已装 nvm 的 Node 22+ 时会自动切换；也可显式指定：',
    '      PREFLIGHT_NODE=/path/to/node npm test',
    '    或运行 `nvm use` 后重试。',
    '',
  ].join('\n'),
);
process.exit(1);
