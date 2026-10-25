/**
 * 文件树行末元信息的格式化（大小 / 修改时间）。
 *
 * 抽成纯函数：便于单测（repro/filemeta-check.ts），也避免 FileTreeNode 里堆分支。
 * 口径统一按 1024 进制、标 KB/MB（与资源管理器一致，不用 KiB 那套）。
 */

/** 一位小数，>=100 时取整——三位数再带小数既没意义又占宽 */
function trimNum(n: number): string {
  const v = n >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
  return String(v);
}

/** 文件大小 → 短标签：512 B / 12.4 KB / 3.2 MB / 1.1 GB */
export function formatFileSize(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${trimNum(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${trimNum(mb)} MB`;
  return `${trimNum(mb / 1024)} GB`;
}

const pad2 = (v: number): string => String(v).padStart(2, '0');

/**
 * 修改时间 → 短标签（越近越详细，给文件名让出宽度）：
 * 今天 → `HH:mm`；今年 → `MM-DD HH:mm`；往年 → `YYYY-MM-DD`。
 */
export function formatFileMtime(ms?: number, now: number = Date.now()): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const n = new Date(now);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate()
  ) {
    return hm;
  }
  const md = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  if (d.getFullYear() === n.getFullYear()) return `${md} ${hm}`;
  return `${d.getFullYear()}-${md}`;
}

/** 悬停提示用的完整口径：`2026-10-24 20:31 · 12.4 KB`（缺项自动省略） */
export function formatFileMetaFull(size?: number, mtimeMs?: number): string {
  const parts: string[] = [];
  if (mtimeMs !== undefined && Number.isFinite(mtimeMs) && mtimeMs > 0) {
    const d = new Date(mtimeMs);
    parts.push(
      `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
    );
  }
  const s = formatFileSize(size);
  if (s) parts.push(s);
  return parts.join(' · ');
}
