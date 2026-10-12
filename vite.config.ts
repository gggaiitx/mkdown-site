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
