'use strict';
/** 极简断言工具 —— 不引任何测试框架，保持零依赖 */
let checks = 0;
let failures = 0;

function ok(cond, msg) {
  checks++;
  if (cond) {
    console.log(`  \u2713 ${msg}`);
  } else {
    failures++;
    console.error(`  \u2717 ${msg}`);
  }
}

function eq(actual, expected, msg) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  checks++;
  if (same) {
    console.log(`  \u2713 ${msg}`);
  } else {
    failures++;
    console.error(`  \u2717 ${msg}\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`);
  }
}

function includes(haystack, needle, msg) {
  const same = String(haystack).includes(needle);
  checks++;
  if (same) {
    console.log(`  \u2713 ${msg}`);
  } else {
    failures++;
    console.error(`  \u2717 ${msg}\n      未找到: ${needle}`);
  }
}

function section(title) {
  console.log(`\n== ${title}`);
}

function finish() {
  console.log(`\n—— ${checks - failures}/${checks} 通过`);
  process.exit(failures ? 1 : 0);
}

async function waitFor(predicate, timeoutMs = 120_000, label = '条件') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待超时：${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

module.exports = { ok, eq, includes, section, finish, waitFor };
