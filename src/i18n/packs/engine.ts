/**
 * 引擎提示语语言包（MdEditorV3Engine 的 toast 等运行时文案）。
 */
export default {
  zh: {
    engine: {
      saveImgFirst: '请先保存文档（Ctrl+S），再粘贴/插入图片',
      imgSaveFail: '图片保存失败：{msg}',
      openUrlFail: '浏览器打开失败：{url}',
      noJumpLink: '应用内不跳转该链接：{href}',
      exportPreviewMissing: '导出预览体未就绪（export-pdf-preview 缺失）',
    },
  },
  en: {
    engine: {
      saveImgFirst: 'Save the document first (Ctrl+S) before pasting/inserting images',
      imgSaveFail: 'Failed to save image: {msg}',
      openUrlFail: 'Failed to open in browser: {url}',
      noJumpLink: 'This link is not opened in-app: {href}',
      exportPreviewMissing: 'Export preview is not ready (export-pdf-preview missing)',
    },
  },
};
