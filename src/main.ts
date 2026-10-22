import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { vTip } from './utils/vTip';
import { watchDprVar } from './utils/devicePixel';

// 1px 细线按设备像素折算（见 utils/devicePixel.ts 与 FileTree/OutlinePanel 的边线）
watchDprVar();

const app = createApp(App);
app.use(createPinia());
app.directive('tip', vTip);
app.mount('#app');
