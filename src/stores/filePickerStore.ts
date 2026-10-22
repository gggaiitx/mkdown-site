import { defineStore } from 'pinia';
import { ref } from 'vue';

export type FilePickerMode = 'file' | 'save';

export interface FilePickerRequest {
  mode: FilePickerMode;
  title: string;
  /** 初始定位目录（也可传文件路径，后端会落到其父目录并预选） */
  initialPath?: string;
  /** 保存模式的默认文件名 */
  defaultName?: string;
  /** 保存模式缺扩展名时补上的扩展名（不含点） */
  ext?: string;
  /** 文件模式只列出这些扩展名（不含点）；为空则全部列出 */
  exts?: string[];
}

/** 全局唯一的文件选择器宿主：调用方 await open() 拿选中路径（取消为 null）。
 *  Workbench 渲染组件，Word 反转弹窗等子组件只要调用 store 即可，避免各自叠一层模态。 */
export const useFilePickerStore = defineStore('filePicker', () => {
  const visible = ref(false);
  const request = ref<FilePickerRequest>({ mode: 'file', title: '' });
  let resolve: ((path: string | null) => void) | null = null;

  function open(req: FilePickerRequest): Promise<string | null> {
    // 新请求顶掉旧请求（正常流程不会并发；兜底避免旧 Promise 永久挂起）
    resolve?.(null);
    request.value = req;
    visible.value = true;
    return new Promise((r) => {
      resolve = r;
    });
  }

  function close(path: string | null) {
    visible.value = false;
    const r = resolve;
    resolve = null;
    r?.(path);
  }

  return { visible, request, open, close };
});
