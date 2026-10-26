"use client";

import { useEffect } from "react";

/**
 * 详情页的复制闸门：页面本身用 select-none 关掉选中，
 * 这里再拦一次剪贴板事件，避免脚本或右键菜单绕过选区。
 *
 * 输入框、文本域和 contenteditable 放行，评论/后台编辑照常工作。
 */
export function CopyGuard() {
  useEffect(() => {
    const block = (event: ClipboardEvent) => {
      const target = event.target instanceof Element ? event.target : document.activeElement;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      event.preventDefault();
    };
    document.addEventListener("copy", block);
    document.addEventListener("cut", block);
    return () => {
      document.removeEventListener("copy", block);
      document.removeEventListener("cut", block);
    };
  }, []);

  return null;
}
