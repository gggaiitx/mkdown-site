/**
 * 预览区组件文案（ns: preview，供 DocxPreview/SheetPreview/ImagePreview/
 * OpenSystemBtn/PreviewZoomBar/HtmlFrame/SvgFrame 共用）
 */
export default {
  zh: {
    preview: {
      loading: '加载中…',
      loadFail: '预览失败：{msg}',
      parsingDocx: '正在解析 Word 文档…',
      parsingSheet: '正在解析表格…',
      docxFailHint: '可点击右上角按钮用系统默认程序打开',
      sheetFailHint: '可在文件树中右键用系统默认程序打开',
      imgLoadFail: '图片无法加载，可用系统默认程序打开',
      openSystem: '系统打开',
      openSystemTitle: '用系统默认程序打开',
      openedWithSystem: '已用系统默认程序打开：{name}',
      zoomOut: '缩小',
      zoomIn: '放大',
      actualSize: '实际大小 100%',
      fitWindow: '适应窗口',
      clickReset: '点击重置 100%',
      resetZoom: '重置 100%',
      htmlTitle: 'HTML 预览',
      svgTitle: 'SVG 预览',
    },
  },
  en: {
    preview: {
      loading: 'Loading…',
      loadFail: 'Preview failed: {msg}',
      parsingDocx: 'Parsing Word document…',
      parsingSheet: 'Parsing spreadsheet…',
      docxFailHint: 'Click the button at the top right to open with the system default app',
      sheetFailHint: 'Right-click the file in the tree to open with the system default app',
      imgLoadFail: 'Image failed to load. You can open it with the system default app',
      openSystem: 'Open in System',
      openSystemTitle: 'Open with system default app',
      openedWithSystem: 'Opened with system default app: {name}',
      zoomOut: 'Zoom out',
      zoomIn: 'Zoom in',
      actualSize: 'Actual size 100%',
      fitWindow: 'Fit window',
      clickReset: 'Click to reset to 100%',
      resetZoom: 'Reset to 100%',
      htmlTitle: 'HTML Preview',
      svgTitle: 'SVG Preview',
    },
  },
};
