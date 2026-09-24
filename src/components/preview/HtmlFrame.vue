<script setup lang="ts">
/**
 * HTML 预览框架：iframe srcdoc 渲染。
 *
 * 安全边界（刻意设计）：
 * - sandbox 仅 allow-same-origin（不含 allow-scripts/form/popup）→ 文档内脚本不执行；
 * - srcdoc 文档继承父窗口 CSP（script-src 'self'）→ 双保险，内联与外链脚本都被拦；
 * - <base href=asset://…> 注入后相对路径的 CSS/图片可正常加载
 *   （CSP style-src/img-src 已放行 asset: http://asset.localhost）。
 * 适用场景：查看静态页面效果；带交互脚本的页面仍需浏览器打开。
 */
import { ref, watch } from 'vue';

import OpenSystemBtn from './OpenSystemBtn.vue';

const props = defineProps<{
  /** HTML 源码 */
  content: string;
  /** 文档所在目录（相对资源解析基准），null/空 = 不注入 base */
  dir: string | null;
  /** 文件完整路径（右上角"系统打开"按钮用），null = 不显示按钮 */
  path?: string | null;
}>();

const srcdoc = ref('');
let timer: ReturnType<typeof setTimeout> | null = null;

function build() {
  let doc = props.content;
  const dir = props.dir ?? '';
  if (dir) {
    // 与 Tauri convertFileSrc 的 Windows 形态一致：http://asset.localhost/<encodeURIComponent(路径)>
    const base = `http://asset.localhost/${encodeURIComponent(dir)}/`;
    if (/<head[^>]*>/i.test(doc)) {
      doc = doc.replace(/<head([^>]*)>/i, `<head$1><base href="${base}">`);
    } else if (/<html[^>]*>/i.test(doc)) {
      doc = doc.replace(/<html([^>]*)>/i, `<html$1><head><base href="${base}"></head>`);
    } else {
      doc = `<base href="${base}">` + doc;
    }
  }
  srcdoc.value = doc;
}

watch(
  () => [props.content, props.dir] as const,
  () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(build, 300); // 编辑态连续键入不重渲染
  },
  { immediate: true },
);
</script>

<template>
  <div class="html-frame-host">
    <iframe
      class="html-frame"
      :srcdoc="srcdoc"
      sandbox="allow-same-origin"
      title="HTML 预览"
    ></iframe>
    <OpenSystemBtn v-if="path" :path="path" />
  </div>
</template>

<style scoped>
.html-frame-host {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #fff;
}
.html-frame {
  width: 100%;
  height: 100%;
  border: none;
  display: block;
}
</style>
