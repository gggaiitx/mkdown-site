import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Tauri 期望固定的前端端口，失败即退出而不是换端口
export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  // 预打包 Tauri API（含 @tauri-apps/api/app 的 getVersion），避免后续 HMR
  // 发现新依赖时触发重新优化、改写 node_modules/.vite 触发 safe-delete 批量删除拦截
  optimizeDeps: {
    include: ['@tauri-apps/api', '@tauri-apps/api/app', '@tauri-apps/api/window', '@tauri-apps/api/core'],
    // ★ exclude 必须保持为空（2026-10-13 白板事故复盘）：mammoth/turndown/docx/xlsx/
    //   docx-preview 均为 CJS 包，一旦 exclude，vite 会把 CJS 源码原样直供浏览器，
    //   ESM 链接报 "does not provide an export named 'default'" → 整个模块图挂掉 → 白板。
    //   之前的 exclude 是为规避「运行时首次请求新依赖 → 重建预构建 → commit 删旧 deps
    //   触发 safe-delete 崩溃」；但正确的规避方式是：装新依赖后先停 dev、删 .vite、再启动
    //   （启动扫描一次性预构建全部依赖，全新 cache 无旧目录可删，不会触发批量删除拦截）。
    //   仅纯 ESM 且确实无法预构建的包才允许进 exclude。
    exclude: [],
  },
  build: {
    // chrome105 → chrome120（P2-15）：Tauri 2 的 WebView2 evergreen 远高于 105，
    // 原锚定过低白放弃 ES 新特性优化；120 与 Tauri 2 最低 WebView2 要求对齐
    target: 'chrome120',
    minify: 'esbuild',
    // 保持 false（P2-26 的 'hidden' 已回退）：Tauri 打包会把 frontendDist 整个目录
    // （含 .map）嵌进二进制，v0.5.6 实测主程序 9.4MB→14.9MB、安装包近翻倍。
    // 排障用的源图走 CI 归档，不随应用分发。
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          mdeditor: ['md-editor-v3'],
          // mermaid/katex 由 md-editor-v3 内部按需加载，不在此显式切分
        },
      },
    },
  },
});
