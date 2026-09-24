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
