import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { vTip } from './utils/vTip';
import { watchDprVar } from './utils/devicePixel';
import { installContextMenuGuard } from './utils/contextMenuGuard';

// 1px 细线按设备像素折算（见 utils/devicePixel.ts 与 FileTree/OutlinePanel 的边线）
watchDprVar();

// 全局右键守卫：除自绘菜单区域外，禁用 WebView 原生上下文菜单（见 utils/contextMenuGuard.ts）
installContextMenuGuard();

const app = createApp(App);
app.use(createPinia());
app.directive('tip', vTip);
app.mount('#app');
