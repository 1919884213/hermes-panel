/**
 * 行级 diff（纯函数）—— 用于把 ACP 审批请求里的
 * `content: [{type:'diff', path, oldText?, newText}]` 渲染成 Codex 那样的
 * 增删行视图。
 *
 * 朴素 LCS，带规模保护：超大文件退回「整块替换」的展示，避免 O(n*m) 卡死面板。
 */

export type DiffRowType = 'add' | 'del' | 'ctx' | 'meta';

export interface DiffRow {
  t: DiffRowType;
  s: string;
  /** 旧文件行号（add 行为空） */
  oldNo?: number;
  /** 新文件行号（del 行为空） */
  newNo?: number;
}

export interface DiffResult {
  rows: DiffRow[];
  added: number;
  removed: number;
  truncated: boolean;
}

const MAX_LINES = 1200;

export function splitLines(text: string | undefined | null): string[] {
  if (text === undefined || text === null || text === '') {
    return [];
  }
  const normalized = String(text).replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

export function lineDiff(oldText: string | null | undefined, newText: string | null | undefined): DiffResult {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    const rows: DiffRow[] = [];
    for (const line of a) {
      rows.push({ t: 'del', s: line });
    }
    for (const line of b) {
      rows.push({ t: 'add', s: line });
    }
    return { rows, added: b.length, removed: a.length, truncated: true };
  }

  // LCS 长度表
  const n = a.length;
  const m = b.length;
  const table: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) {
    table.push(new Uint32Array(m + 1));
  }
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  let oldNo = 1;
  let newNo = 1;

  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ t: 'ctx', s: a[i], oldNo: oldNo++, newNo: newNo++ });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      rows.push({ t: 'del', s: a[i], oldNo: oldNo++ });
      removed++;
      i++;
    } else {
      rows.push({ t: 'add', s: b[j], newNo: newNo++ });
      added++;
      j++;
    }
  }
  while (i < n) {
    rows.push({ t: 'del', s: a[i++], oldNo: oldNo++ });
    removed++;
  }
  while (j < m) {
    rows.push({ t: 'add', s: b[j++], newNo: newNo++ });
    added++;
  }

  return { rows, added, removed, truncated: false };
}

/** 把 diff 渲染成 HTML（消息里的 diff 卡片）
 *  只保留一列行号：侧边栏只有 400 多像素，双列行号会把代码挤到看不见。 */
export function renderDiffHtml(result: DiffResult, escape: (s: string) => string): string {
  const parts: string[] = [];
  for (const row of result.rows) {
    const sign = row.t === 'add' ? '+' : row.t === 'del' ? '-' : ' ';
    const cls = row.t === 'add' ? 'd-add' : row.t === 'del' ? 'd-del' : 'd-ctx';
    // 新增行显示新行号，删除行显示旧行号，上下文行两者一致
    const lineNo = row.t === 'del' ? row.oldNo : row.newNo;
    parts.push(
      `<div class="d-row ${cls}"><span class="d-no">${lineNo ?? ''}</span>` +
        `<span class="d-sign">${sign}</span><span class="d-txt">${escape(row.s) || '&nbsp;'}</span></div>`
    );
  }
  return parts.join('');
}
