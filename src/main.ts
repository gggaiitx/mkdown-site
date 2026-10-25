import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { vTip } from './utils/vTip';
import { watchDprVar } from './utils/devicePixel';
import { installContextMenuGuard } from './utils/contextMenuGuard';
import { installRendererErrorHandler } from './utils/rendererError';

// 1px 细线按设备像素折算（见 utils/devicePixel.ts 与 FileTree/OutlinePanel 的边线）
watchDprVar();

// 全局右键守卫：除自绘菜单区域外，禁用 WebView 原生上下文菜单（见 utils/contextMenuGuard.ts）
installContextMenuGuard();

const app = createApp(App);
app.use(createPinia());
// 全局错误兜底：必须在 pinia 之后装（提示要经 editorStore 的 toast），
// 早于挂载装才能接住首屏渲染阶段的异常
installRendererErrorHandler(app);
app.directive('tip', vTip);
app.mount('#app');
