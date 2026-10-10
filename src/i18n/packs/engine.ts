/**
 * 引擎提示语语言包（MdEditorV3Engine 的 toast 等运行时文案）。
 */
export default {
  zh: {
    engine: {
      saveImgFirst: '请先保存文档（{mod}+S），再粘贴/插入图片',
      imgSaveFail: '图片保存失败：{msg}',
      openUrlFail: '浏览器打开失败：{url}',
      noJumpLink: '应用内不跳转该链接：{href}',
      exportPreviewMissing: '导出预览体未就绪（export-pdf-preview 缺失）',
      createdMh: '已新建 .mh 富文本文档',
      pageFullscreen: '全屏（F11）',
      exitPageFullscreen: '退出全屏（F11）',
    },
  },
  en: {
    engine: {
      saveImgFirst: 'Save the document first ({mod}+S) before pasting/inserting images',
      imgSaveFail: 'Failed to save image: {msg}',
      openUrlFail: 'Failed to open in browser: {url}',
      noJumpLink: 'This link is not opened in-app: {href}',
      exportPreviewMissing: 'Export preview is not ready (export-pdf-preview missing)',
      createdMh: 'New .mh rich text document created',
      pageFullscreen: 'Fullscreen (F11)',
      exitPageFullscreen: 'Exit fullscreen (F11)',
    },
  },
};
