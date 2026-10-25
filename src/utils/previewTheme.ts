/**
 * 预览主题可选项（Markdown 预览正文的排版皮肤）。
 * 内置 6 项来自 @vavt/markdown-theme；win 为本项目自建 Windows 11 Fluent 风主题
 * （样式见 src/styles/win-theme.css）。
 *
 * 唯一真相源：设置面板「外观 · 预览主题」下拉与编辑区右键「预览主题」飞窗共用这一份，
 * 加主题只改这里。label 存 i18n key，调用方经 t() 现取当前语言。
 */
export const PREVIEW_THEMES: Array<{ value: string; label: string }> = [
  { value: 'default', label: 'settings.ptDefault' },
  { value: 'github', label: 'settings.ptGithub' },
  { value: 'vuepress', label: 'settings.ptVuepress' },
  { value: 'mk-cute', label: 'settings.ptMkCute' },
  { value: 'smart-blue', label: 'settings.ptSmartBlue' },
  { value: 'cyanosis', label: 'settings.ptCyanosis' },
  { value: 'win', label: 'settings.ptWin' },
];
