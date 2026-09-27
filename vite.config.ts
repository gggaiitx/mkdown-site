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
    target: 'chrome105',
    minify: 'esbuild',
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
