export function debounce<F extends (...args: never[]) => void>(fn: F, delayMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const wrapped = (...args: Parameters<F>) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delayMs);
  };
  wrapped.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return wrapped;
}

/** 字数统计：对齐 md-editor 内置 markdownTotal 口径 = 内容总字符数（含空格换行，见 MdEditor.mjs footer 组件 modelValue.length） */
export function countChars(text: string): number {
  return text.length;
}
