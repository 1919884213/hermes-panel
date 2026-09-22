'use strict';
/**
 * 顺序跑所有测试文件。
 *   node test/run-all.js            全跑（含真连 hermes 的活体测试）
 *   SKIP_LIVE=1 node test/run-all.js  只跑离线部分
 */
const { spawnSync } = require('child_process');
const path = require('path');

const SUITE = [
  'test-markdown.js',
  'test-diff.js',
  'test-protocol.js',
  'test-transcript.js',
  'test-manifest.js',
  'test-ui-behavior.js',
  'test-extension.js',
  'test-acp-live.js',
];

const LIVE_TESTS = new Set(['test-extension.js', 'test-acp-live.js']);
const skipLive = process.env.SKIP_LIVE === '1';

let failed = 0;
const results = [];

for (const file of SUITE) {
  const full = path.join(__dirname, file);
  if (skipLive && LIVE_TESTS.has(file)) {
    results.push({ file, status: '（已跳过，SKIP_LIVE=1）' });
    continue;
  }
  console.log(`\n${'━'.repeat(60)}\n▶ ${file}\n${'━'.repeat(60)}`);
  const res = spawnSync(process.execPath, [full], { stdio: 'inherit', env: process.env });
  if (res.status === 0) {
    results.push({ file, status: '✔ 通过' });
  } else {
    failed++;
    results.push({ file, status: `✘ 失败 (exit=${res.status})` });
  }
}

console.log(`\n${'━'.repeat(60)}\n测试汇总\n${'━'.repeat(60)}`);
for (const r of results) {
  console.log(`  ${r.status.padEnd(26)} ${r.file}`);
}
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 个测试文件失败`}`);
process.exit(failed === 0 ? 0 : 1);
