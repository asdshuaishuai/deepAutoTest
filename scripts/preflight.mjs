// Node 版本闸：本项目需要 Node 22+（node:sqlite / 类型剥离）。
// 常见事故：shell 里 nvm 的旧版本排在 PATH 前面，vitest 在 Node 20 下静默失败。
// 这里明说原因与处置，而不是让下游报 "No such built-in module: node:sqlite"。

const version = process.versions.node;
const major = Number.parseInt(version.split('.')[0] ?? '0', 10);

if (major < 22) {
  console.error(
    [
      '',
      `  ✗ 需要 Node 22+（当前 v${version}）。`,
      '    项目已含 .nvmrc —— 运行 `nvm use` 后重试；',
      '    或直接用 Node 22 的绝对路径，例如：/usr/local/bin/npm test',
      '',
    ].join('\n'),
  );
  process.exit(1);
}
