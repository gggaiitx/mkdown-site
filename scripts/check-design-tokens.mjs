#!/usr/bin/env node
/**
 * 设计 token 守卫：每个被 var(--mk-*) 消费的名字，必须在样式里有定义。
 *
 * 为什么需要：曾有 6 个 token（--mk-fg-soft / --mk-panel-soft / --mk-bg-input /
 * --mk-cm-caret / --mk-cm-sel / --mk-cm-active）全项目只有 `var(--x, #666)` 这种
 * 带兜底的消费点，没有任何定义 —— 兜底色成了实际配色，暗色主题下退化成 #666（对比 3.2:1）。
 * 这类"变量名不存在"的故障肉眼看不出来，只能靠断言挡。
 *
 * 用法：node scripts/check-design-tokens.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const SRC = join(ROOT, 'src');

/** 由脚本在运行时注入的行内几何变量，CSS 里天然没有定义 */
const INJECTED = new Set([
  '--mk-font-size', // settingsStore.applyTheme
  '--mk-ln-pad', // MdEditorV3Engine :style 量出来的留白
  '--mk-ln-gut',
  '--mk-ln-x',
  '--mk-ln-pull',
  '--mk-content-w',
  '--mk-right-div-x', // Toolbar 拖拽分隔线锚点
]);

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(vue|css|ts)$/.test(name)) files.push(p);
  }
};
walk(SRC);

const used = new Map(); // token -> [file:line]
const defined = new Set();

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/var\((--mk-[a-z0-9-]+)/g)) {
      const token = m[1];
      if (!used.has(token)) used.set(token, []);
      used.get(token).push(`${relative(SRC, file)}:${i + 1}`);
    }
    // 定义：CSS 声明 `--x:`，或 JS 对象键 `'--x':` / setProperty('--x', ...)
    for (const m of line.matchAll(/(--mk-[a-z0-9-]+)['"]?\s*(:|,)/g)) defined.add(m[1]);
  });
}

const missing = [...used.keys()].filter(
  (t) => !defined.has(t) && !INJECTED.has(t),
);

if (missing.length) {
  console.error('✗ 以下 token 被消费但没有任何定义：\n');
  for (const t of missing) console.error(`  ${t}\n    ${used.get(t).join('\n    ')}`);
  console.error('\n修法：在 src/styles/global.css 的 :root 与 :root[data-theme=\'dark\'] 各补一条定义。');
  process.exit(1);
}

console.log(`✓ ${used.size} 个 --mk-* token 全部有定义（${files.length} 个文件）`);
