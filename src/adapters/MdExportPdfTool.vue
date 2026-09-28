<script setup lang="ts">
/**
 * 官方 ExportPDF 的 defToolbars 插槽包装层。
 *
 * 为什么需要这层包装：v7 渲染 defToolbars 子组件时会强制 clone props
 * （MdEditor.mjs barRender）：
 *   theme:        p.props?.theme || 编辑器theme
 *   previewTheme: p.props?.theme || 编辑器previewTheme   ← 错绑，读的是 theme
 *   language:     p.props?.theme || 编辑器language       ← 同样被 theme 污染
 * 若在插槽上直接传 theme/previewTheme，language 会变成 "light" 导致官方组件
 * 文案回落英文；不传则导出预览体跟随应用暗色主题，打印产物不可读。
 *
 * 包装层自身不声明 theme/previewTheme/language（clone 的覆盖落在包装层上、被忽略），
 * 内部以自有 vnode 渲染官方 ExportPDF，固定 light 主题 + zh-CN 文案。
 * 导出预览体（MdPreview id=export-pdf-preview）恒驻 DOM，弹窗未打开也渲染。
 */
import { ref } from 'vue';
import { ExportPDF } from '@vavt/v3-extension';
// 官方打印样式：@media print 隐藏 body 直下所有节点，仅放行 .md-editor-modal-container
// 弹窗链路内的 #export-pdf-preview（Modal 经 Teleport 渲染在 body 直下）
import '@vavt/v3-extension/lib/asset/ExportPDF.css';

// 关键：关闭属性透传。v7 clone 强塞的 theme/previewTheme/language 未在本组件声明，
// 若透传会经 mergeProps 覆盖下面显式传给 ExportPDF 的 theme="light"（无头实测复现）。
defineOptions({ inheritAttrs: false });

defineProps<{
  modelValue: string;
  /** 只读态禁用（v7 clone 会注入编辑器的只读状态） */
  disabled?: boolean;
  /** 图标下显示文字标签 */
  showToolbarName?: boolean;
}>();

// 官方组件由 defineComponent + expose 定义，类型推导不含 expose 成员，按实际暴露接口声明
const innerRef = ref<{ trigger?: () => void } | null>(null);

/** 直通官方 trigger：校验预览体存在 → window.print() */
function trigger(): void {
  innerRef.value?.trigger?.();
}

defineExpose({ trigger });
</script>

<template>
  <ExportPDF
    ref="innerRef"
    :model-value="modelValue"
    theme="light"
    preview-theme="light"
    code-theme="github"
    language="zh-CN"
    :disabled="disabled"
    :show-toolbar-name="showToolbarName"
  />
</template>
