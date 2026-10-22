/**
 * 目录/相对路径拼接（跨平台）。
 *
 * 背景：**分隔符不能写死**。Windows 用 `\`、macOS/Linux 用 `/`；写死 `\` 在 mac 上会把
 * `/Users/fei/Documents` 与 `笔记.md` 拼成 `/Users/fei/Documents\笔记.md` —— Rust 侧
 * `PathBuf` 会把它当成**单个文件名**，文件不报错地落进 `/Users/fei/` 且名字带反斜杠
 * （另存为 / 导出静默错位），图片路径则直接 404。
 *
 * 判据取「基准目录自身的形态」而不是探测平台：
 *  - `C:` / `C:\…` 盘符路径必然是 Windows；
 *  - 目录里已经出现 `\` 说明是 Windows 原生分隔符；
 *  - 其余（mac/Linux 的 `/…`、UNC `\\host\share`、以及空基准）一律按 `/` 处理。
 */

const WIN_DRIVE = /^[a-zA-Z]:/;

/** 该路径是否是 Windows 形态（盘符或含反斜杠） */
export function isWinStylePath(p: string): boolean {
  return WIN_DRIVE.test(p) || p.includes('\\');
}

/** 目录 + 单个名字（文件名 / 目录名）。`dir` 为空时原样返回名字 */
export function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  if (!name) return dir;
  if (/[\\/]$/.test(dir)) return `${dir}${name}`;
  return `${dir}${isWinStylePath(dir) ? '\\' : '/'}${name}`;
}

/** 目录 + 相对子路径（`rel` 按约定用 `/` 分隔，如 `assets/a.png`）：
 *  Windows 下顺手把分隔符折成本地风格，其余平台保持 `/` */
export function joinRelPath(dir: string, rel: string): string {
  if (!dir) return rel;
  const leaf = isWinStylePath(dir) ? rel.replaceAll('/', '\\') : rel;
  return joinPath(dir, leaf);
}

/**
 * `path` 是否在目录 `dir` 内（含 dir 自身）。
 *
 * 不直接 `startsWith`：Windows 上 dir 与 path 可能一个用 `\` 一个用 `/`
 * （后端回来的路径与用户选择器给的路径分隔符并不保证一致），
 * 且必须挡住「D:\work 匹配到 D:\workshop」这种前缀相同但不同目录的误判。
 */
export function isPathInside(dir: string, path: string): boolean {
  if (!dir || !path) return false;
  const win = isWinStylePath(dir);
  const norm = (s: string): string => (win ? s.replaceAll('/', '\\') : s.replaceAll('\\', '/'));
  const base = norm(dir).replace(/[\\/]+$/, '');
  const target = norm(path);
  if (target === base) return true;
  return target.startsWith(win ? `${base}\\` : `${base}/`);
}
