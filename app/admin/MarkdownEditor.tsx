"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { highlightHashtagsForEditorHtml } from "@/lib/editor-hashtag-highlight";
import { wholeLineHashtagName } from "@/lib/hashtags";
import { renderMarkdown, markdownHeadingClass, markdownPreviewProseClass } from "@/lib/markdown";

/** 行首 `/` 命令：优先级别（标题 1/2/3、圆点、数字编号）。 */
const SLASH_COMMANDS: {
  id: string;
  label: string;
  hint: string;
  keys: string[];
  prefix: string;
}[] = [
  {
    id: "h1",
    label: "一级标题",
    hint: "# + 空格",
    keys: ["1", "h1", "bt", "title", "yiji", "一级"],
    prefix: "# ",
  },
  {
    id: "h2",
    label: "二级标题",
    hint: "## + 空格",
    keys: ["2", "h2", "erji", "二级"],
    prefix: "## ",
  },
  {
    id: "h3",
    label: "三级标题",
    hint: "### + 空格",
    keys: ["3", "h3", "sanji", "三级"],
    prefix: "### ",
  },
  {
    id: "bul",
    label: "无序列表 · 圆点",
    hint: "- ",
    keys: ["ul", "无序", "圆点", "点", "liebiao", "-"],
    prefix: "- ",
  },
  {
    id: "num",
    label: "有序列表 · 1. 2. 3.",
    hint: "1. ",
    keys: ["ol", "有序", "数字", "编号", "1"],
    prefix: "1. ",
  },
  {
    id: "todo",
    label: "待办",
    hint: "- [ ]",
    keys: ["todo", "待办", "checkbox", "[]"],
    prefix: "- [ ] ",
  },
  {
    id: "quote",
    label: "引用",
    hint: "> ",
    keys: ["quote", "引用", ">"],
    prefix: "> ",
  },
  {
    id: "div",
    label: "分隔线",
    hint: "---",
    keys: ["div", "分隔", "hr", "---"],
    prefix: "---\n",
  },
  {
    id: "code",
    label: "代码块",
    hint: "```",
    keys: ["code", "代码"],
    prefix: "```\n\n```",
  },
];

const AI_PRESETS: { label: string; instruction: string }[] = [
  { label: "续写", instruction: "根据上下文自然续写一段，保持 Notion 式 Markdown：标题用「# + 空格」「## + 空格」等；紧贴 # 的为标签 #标签。语气与上文一致。" },
  { label: "润色", instruction: "润色选中内容，使语句更通顺简洁，保留 Markdown 结构（标题、列表、待办等与 Notion 快捷键一致）。" },
  { label: "列要点", instruction: "将选中内容改写成多级 Markdown 无序列表要点，层次清晰。" },
  { label: "略正式", instruction: "将选中内容改写得略正式、书面一些，保留 Notion 兼容 Markdown。" },
];

/** 行首在已有 indentLen 字符的缩进后插入 insertLen 个字符时映射原 caret（落在缩进内则不变）。 */
function caretAfterGrowIndentAtLineStart(
  lineStart: number,
  caret: number,
  indentLen: number,
  insertLen: number
): number {
  const contentStart = lineStart + indentLen;
  return caret < contentStart ? caret : caret + insertLen;
}

/** 从行首删掉连续 shrinkLen 个字符后映射 caret（落在删区内则夹到行首）。 */
function caretAfterShrinkLineStart(
  lineStart: number,
  caret: number,
  shrinkLen: number
): number {
  const delEnd = lineStart + shrinkLen;
  if (caret <= lineStart) return caret;
  if (caret < delEnd) return lineStart;
  return caret - shrinkLen;
}

export default function MarkdownEditor({
  value,
  onChange,
  rows = 14,
  placeholder = "行首 / 或 /文字前输入 / 唤出命令；标题行 Tab / Shift+Tab 调整级别；紧贴 #标签 ；Shift+Enter 换行",
}: {
  value: string;
  onChange: (next: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const editBackdropInnerRef = useRef<HTMLDivElement>(null);
  /** Slash 打开期间最后一次光标，避免点菜单时 selection 丢失。 */
  const slashCursorPosRef = useRef(0);
  const previewHtml = useMemo(() => renderMarkdown(value), [value]);
  const editBackdropHtml = useMemo(
    () => highlightHashtagsForEditorHtml(value).replace(/\n/g, "<br/>"),
    [value]
  );

  const syncEditBackdropScroll = useCallback((t: HTMLTextAreaElement) => {
    const inner = editBackdropInnerRef.current;
    if (inner) {
      inner.style.transform = `translate(${-t.scrollLeft}px,${-t.scrollTop}px)`;
    }
  }, []);

  useLayoutEffect(() => {
    if (mode !== "edit" || !taRef.current) return;
    syncEditBackdropScroll(taRef.current);
  }, [mode, value, syncEditBackdropScroll]);

  const [slashOpen, setSlashOpen] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  /** 行内 `/` 的起始下标（去掉 /…filter 后接上 prefix，保留光标后的正文）。 */
  const [slashReplaceStart, setSlashReplaceStart] = useState(0);
  const [slashLineEnd, setSlashLineEnd] = useState(0);
  const [slashSelected, setSlashSelected] = useState(0);

  const filteredSlash = useMemo(() => {
    const f = slashFilter.toLowerCase().trim();
    if (!f) return SLASH_COMMANDS;
    return SLASH_COMMANDS.filter(
      (c) =>
        c.label.toLowerCase().includes(f) ||
        c.hint.toLowerCase().includes(f) ||
        c.keys.some((k) => k.includes(f) || f.includes(k))
    );
  }, [slashFilter]);

  useEffect(() => {
    setSlashSelected((i) =>
      filteredSlash.length ? Math.min(i, filteredSlash.length - 1) : 0
    );
  }, [filteredSlash.length]);

  const closeSlashMenu = useCallback(() => {
    setSlashOpen(false);
    setSlashFilter("");
  }, []);

  useEffect(() => {
    if (mode !== "edit") closeSlashMenu();
  }, [closeSlashMenu, mode]);

  const updateSlashFromText = useCallback(
    (v: string, pos: number, selEnd: number) => {
      if (selEnd !== pos) {
        closeSlashMenu();
        return;
      }
      const lineStart = v.lastIndexOf("\n", pos - 1) + 1;
      const lineEnd = v.indexOf("\n", pos);
      const end = lineEnd === -1 ? v.length : lineEnd;
      const line = v.slice(lineStart, end);
      const indent = line.match(/^(\s*)/)?.[1] ?? "";
      const afterIndent = line.slice(indent.length);
      if (!afterIndent.startsWith("/")) {
        closeSlashMenu();
        return;
      }
      const slashIdx = lineStart + indent.length;
      if (pos <= slashIdx) {
        closeSlashMenu();
        return;
      }
      const filter = v.slice(slashIdx + 1, pos);
      slashCursorPosRef.current = pos;
      setSlashOpen(true);
      setSlashFilter(filter.trim());
      setSlashReplaceStart(slashIdx);
      setSlashLineEnd(end);
      if (filter.trim() === "") setSlashSelected(0);
    },
    [closeSlashMenu]
  );

  const applySlashCommand = useCallback(
    (prefix: string) => {
      const ta = taRef.current;
      const pos =
        ta?.selectionStart ?? slashCursorPosRef.current ?? value.length;
      const v = value;
      const end = slashLineEnd;
      const start = slashReplaceStart;
      const newValue = v.slice(0, start) + prefix + v.slice(pos, end) + v.slice(end);
      onChange(newValue);
      closeSlashMenu();
      const caret = start + prefix.length;
      requestAnimationFrame(() => {
        const el = taRef.current;
        if (el) el.selectionStart = el.selectionEnd = caret;
        el?.focus();
      });
    },
    [closeSlashMenu, onChange, slashLineEnd, slashReplaceStart, value]
  );

  const cancelSlashLine = useCallback(() => {
    const ta = taRef.current;
    const pos =
      ta?.selectionStart ?? slashCursorPosRef.current ?? slashReplaceStart + 1;
    const v = value;
    const newValue =
      v.slice(0, slashReplaceStart) + v.slice(pos, slashLineEnd) + v.slice(slashLineEnd);
    onChange(newValue);
    closeSlashMenu();
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (el) el.selectionStart = el.selectionEnd = slashReplaceStart;
      el?.focus();
    });
  }, [closeSlashMenu, onChange, slashLineEnd, slashReplaceStart, value]);

  const insertSnippet = (snippet: string) => {
    const prefix = value && !value.endsWith("\n") ? "\n" : "";
    onChange(`${value}${prefix}${snippet}`);
  };

  /** 当前行套上无序或有序列表前缀（保留缩进与正文）。 */
  const prefixCurrentLine = useCallback(
    (unordered: boolean) => {
      const v = value;
      const ta = taRef.current;
      const pos = ta?.selectionStart ?? 0;
      const lineStart = v.lastIndexOf("\n", pos - 1) + 1;
      const lineEnd = v.indexOf("\n", pos);
      const end = lineEnd === -1 ? v.length : lineEnd;
      const line = v.slice(lineStart, end);
      const indent = (line.match(/^(\s*)/)?.[1] ?? "");
      const afterIndent = line.slice(indent.length);
      const body = afterIndent.replace(/^([-*+]|\d+\.)\s+/, "");
      const newPrefix = unordered ? "- " : "1. ";
      const newLine = indent + newPrefix + body;
      const newValue = v.slice(0, lineStart) + newLine + v.slice(end);
      onChange(newValue);
      requestAnimationFrame(() => {
        const el = taRef.current;
        if (el) {
          const delta = newLine.length - line.length;
          const p = pos + delta;
          el.selectionStart = el.selectionEnd = Math.max(lineStart, p);
        }
      });
    },
    [onChange, value]
  );

  /** 捕获阶段先取消 Tab 的默认行为，避免在 <form> 内焦点被移到其他控件（冒泡阶段再等长逻辑）。 */
  const handleTabCapture = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (mode !== "edit") return;
      if (e.key !== "Tab") return;
      e.preventDefault();
    },
    [mode]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (mode !== "edit") return;

      if (slashOpen) {
        if (e.key === "Escape") {
          e.preventDefault();
          cancelSlashLine();
          return;
        }
        if (filteredSlash.length > 0) {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            applySlashCommand(filteredSlash[slashSelected].prefix);
            return;
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSlashSelected(
              (i) => (i + 1) % filteredSlash.length
            );
            return;
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setSlashSelected(
              (i) =>
                (i - 1 + filteredSlash.length) % filteredSlash.length
            );
            return;
          }
        }
        if (e.key === "Tab") {
          e.preventDefault();
          const ta0 = e.currentTarget;
          const v0 = value;
          const s0 = ta0.selectionStart;
          const e0 = ta0.selectionEnd;
          if (!e.shiftKey && filteredSlash.length > 0) {
            applySlashCommand(filteredSlash[slashSelected].prefix);
          } else if (!e.shiftKey) {
            const ins = v0.slice(0, s0) + "  " + v0.slice(e0);
            onChange(ins);
            requestAnimationFrame(() => {
              const el = taRef.current;
              if (el) el.selectionStart = el.selectionEnd = s0 + 2;
            });
          } else if (s0 >= 2 && v0.slice(s0 - 2, s0) === "  ") {
            onChange(v0.slice(0, s0 - 2) + v0.slice(e0));
            requestAnimationFrame(() => {
              const el = taRef.current;
              if (el) el.selectionStart = el.selectionEnd = s0 - 2;
            });
          }
          return;
        }
      }

      /**
       * Tab / Shift+Tab：一律截获，避免焦点跳出输入框。
       * 当前行任意光标：标题整行升降级；列表整行加减 2 格缩进（含 - [ ]）；否则多行选区每行加减 2 格，或单光标处插/删空格。
       */
      if (e.key === "Tab" && !slashOpen) {
        e.preventDefault();
        const ta = e.currentTarget;
        const v = value;
        const selStart = ta.selectionStart;
        const selEnd = ta.selectionEnd;
        const lineStart = v.lastIndexOf("\n", selStart - 1) + 1;
        const lineEnd = v.indexOf("\n", selStart);
        const end = lineEnd === -1 ? v.length : lineEnd;
        const line = v.slice(lineStart, end);

        if (selStart !== selEnd) {
          const before = v.slice(0, selStart);
          const chunk = v.slice(selStart, selEnd);
          const after = v.slice(selEnd);
          if (e.shiftKey) {
            const nextChunk = chunk
              .split("\n")
              .map((ln) =>
                ln.startsWith("  ") ? ln.slice(2) : ln.startsWith("\t") ? ln.slice(1) : ln
              )
              .join("\n");
            const newV = before + nextChunk + after;
            onChange(newV);
            const delta = nextChunk.length - chunk.length;
            requestAnimationFrame(() => {
              const el = taRef.current;
              if (el) {
                el.selectionStart = selStart;
                el.selectionEnd = selEnd + delta;
              }
            });
          } else {
            const nextChunk = chunk
              .split("\n")
              .map((ln) => `  ${ln}`)
              .join("\n");
            onChange(before + nextChunk + after);
            requestAnimationFrame(() => {
              const el = taRef.current;
              if (el) {
                el.selectionStart = selStart;
                el.selectionEnd = selEnd + (nextChunk.length - chunk.length);
              }
            });
          }
          return;
        }

        if (e.shiftKey) {
          const taskM = line.match(/^(\s*)(-\s+\[[ xX]\]\s+)(.*)$/);
          if (taskM && taskM[1].length >= 2) {
            const newLine = `${taskM[1].slice(2)}${taskM[2]}${taskM[3]}`;
            const newValue = v.slice(0, lineStart) + newLine + v.slice(end);
            onChange(newValue);
            const nextCaret = caretAfterShrinkLineStart(lineStart, selStart, 2);
            requestAnimationFrame(() => {
              const el = taRef.current;
              if (el) el.selectionStart = el.selectionEnd = nextCaret;
            });
            return;
          }
          const listM = line.match(/^(\s*)((?:[-*+])|(?:\d+\.))(\s+)(.*)$/);
          if (listM && !/^\s*-\s+\[[ xX]\]/.test(line) && listM[1].length >= 2) {
            const newLine = `${listM[1].slice(2)}${listM[2]}${listM[3]}${listM[4]}`;
            const newValue = v.slice(0, lineStart) + newLine + v.slice(end);
            onChange(newValue);
            const nextCaret = caretAfterShrinkLineStart(lineStart, selStart, 2);
            requestAnimationFrame(() => {
              const el = taRef.current;
              if (el) el.selectionStart = el.selectionEnd = nextCaret;
            });
            return;
          }
          const dem = line.match(/^(\s*)(#{2,6})\s+(.*)$/);
          if (dem) {
            const hashes = dem[2].slice(0, -1);
            const newLine = `${dem[1]}${hashes} ${dem[3]}`;
            const newValue = v.slice(0, lineStart) + newLine + v.slice(end);
            onChange(newValue);
            const delta = newLine.length - line.length;
            requestAnimationFrame(() => {
              const el = taRef.current;
              if (el) el.selectionStart = el.selectionEnd = selStart + delta;
            });
            return;
          }
          if (selStart >= 2 && v.slice(selStart - 2, selStart) === "  ") {
            onChange(v.slice(0, selStart - 2) + v.slice(selEnd));
            requestAnimationFrame(() => {
              const el = taRef.current;
              if (el) el.selectionStart = el.selectionEnd = selStart - 2;
            });
          }
          return;
        }

        const pro = line.match(/^(\s*)(#{1,5})\s+(.*)$/);
        if (pro) {
          const newLine = `${pro[1]}${pro[2]}# ${pro[3]}`;
          const newValue = v.slice(0, lineStart) + newLine + v.slice(end);
          onChange(newValue);
          const delta = newLine.length - line.length;
          requestAnimationFrame(() => {
            const el = taRef.current;
            if (el) el.selectionStart = el.selectionEnd = selStart + delta;
          });
          return;
        }

        const taskM = line.match(/^(\s*)(-\s+\[[ xX]\]\s+)(.*)$/);
        if (taskM) {
          const newLine = `${taskM[1]}  ${taskM[2]}${taskM[3]}`;
          const newValue = v.slice(0, lineStart) + newLine + v.slice(end);
          onChange(newValue);
          const nextCaret = caretAfterGrowIndentAtLineStart(
            lineStart,
            selStart,
            taskM[1].length,
            2
          );
          requestAnimationFrame(() => {
            const el = taRef.current;
            if (el) el.selectionStart = el.selectionEnd = nextCaret;
          });
          return;
        }

        const listM = line.match(/^(\s*)((?:[-*+])|(?:\d+\.))(\s+)(.*)$/);
        if (listM && !/^\s*-\s+\[[ xX]\]/.test(line)) {
          const newLine = `${listM[1]}  ${listM[2]}${listM[3]}${listM[4]}`;
          const newValue = v.slice(0, lineStart) + newLine + v.slice(end);
          onChange(newValue);
          const nextCaret = caretAfterGrowIndentAtLineStart(
            lineStart,
            selStart,
            listM[1].length,
            2
          );
          requestAnimationFrame(() => {
            const el = taRef.current;
            if (el) el.selectionStart = el.selectionEnd = nextCaret;
          });
          return;
        }

        onChange(v.slice(0, selStart) + "  " + v.slice(selEnd));
        requestAnimationFrame(() => {
          const el = taRef.current;
          if (el) el.selectionStart = el.selectionEnd = selStart + 2;
        });
        return;
      }

      if (e.key !== "Enter" || e.shiftKey) return;

      const ta = e.currentTarget;
      const v = value;
      const selStart = ta.selectionStart;
      const selEnd = ta.selectionEnd;
      const lineStart = v.lastIndexOf("\n", selStart - 1) + 1;
      const lineEnd = v.indexOf("\n", selStart);
      const end = lineEnd === -1 ? v.length : lineEnd;
      const line = v.slice(lineStart, end);

      /** 单独一行 `#标签` 后回车：换行并自动起一行 `#` 继续输入下一标签。 */
      if (
        selStart === selEnd &&
        selStart === end &&
        wholeLineHashtagName(line) !== null
      ) {
        e.preventDefault();
        const insert = "\n#";
        const newValue = v.slice(0, end) + insert + v.slice(end);
        onChange(newValue);
        const newPos = end + insert.length;
        requestAnimationFrame(() => {
          const el = taRef.current;
          if (el) el.selectionStart = el.selectionEnd = newPos;
        });
        return;
      }

      const listMatch = line.match(/^(\s*)((?:[-*+])|(?:\d+\.))\s+(.*)$/);
      if (!listMatch) return;

      const marker = listMatch[2];
      const body = listMatch[3];

      if (body.trim() === "") {
        e.preventDefault();
        const indent = listMatch[1];
        const newValue = v.slice(0, lineStart) + indent + v.slice(end);
        onChange(newValue);
        requestAnimationFrame(() => {
          const el = taRef.current;
          if (el) {
            const p = lineStart + indent.length;
            el.selectionStart = el.selectionEnd = p;
          }
        });
        return;
      }

      const cursorInLine = selStart - lineStart;
      const markerLen = listMatch[0].length - body.length;
      if (cursorInLine < markerLen && body.trim() !== "") return;

      e.preventDefault();
      let nextMarker = marker;
      if (/^\d+\./.test(marker)) {
        nextMarker = `${parseInt(marker, 10) + 1}.`;
      }

      const indent = listMatch[1];
      const before = line.slice(0, cursorInLine);
      const after = line.slice(cursorInLine);
      const tail = v.slice(end);

      if (cursorInLine >= line.length) {
        const insert = `\n${indent}${nextMarker} `;
        const newValue = v.slice(0, end) + insert + tail;
        onChange(newValue);
        const newPos = end + insert.length;
        requestAnimationFrame(() => {
          const el = taRef.current;
          if (el) el.selectionStart = el.selectionEnd = newPos;
        });
      } else {
        const newLine1 = before;
        const newLine2 = `${indent}${nextMarker} ${after}`;
        const newValue = v.slice(0, lineStart) + newLine1 + "\n" + newLine2 + tail;
        onChange(newValue);
        const newPos =
          lineStart + newLine1.length + 1 + `${indent}${nextMarker} `.length;
        requestAnimationFrame(() => {
          const el = taRef.current;
          if (el) el.selectionStart = el.selectionEnd = newPos;
        });
      }
    },
    [
      applySlashCommand,
      cancelSlashLine,
      filteredSlash,
      mode,
      onChange,
      slashOpen,
      slashSelected,
      value,
    ]
  );

  const handleTextAreaChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      onChange(next);
      const pos = e.target.selectionStart ?? 0;
      const selEnd = e.target.selectionEnd ?? 0;
      requestAnimationFrame(() => {
        updateSlashFromText(next, pos, selEnd);
      });
    },
    [onChange, updateSlashFromText]
  );

  const handleTextAreaSelect = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    updateSlashFromText(value, el.selectionStart, el.selectionEnd);
  }, [updateSlashFromText, value]);

  const runAiAssist = useCallback(async () => {
    if (!aiInstruction.trim()) {
      setAiError("请填写指令或使用上方快捷指令");
      return;
    }
    const ta = taRef.current;
    const v = value;
    const s = ta?.selectionStart ?? 0;
    const e2 = ta?.selectionEnd ?? 0;
    const selection = s !== e2 ? v.slice(s, e2) : "";

    setAiLoading(true);
    setAiError("");
    try {
      const res = await fetch("/api/ai/assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instruction: aiInstruction.trim(),
          selection,
          draft: v,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; text?: string };
      if (!res.ok) {
        setAiError(data.error ?? `请求失败 (${res.status})`);
        return;
      }
      const text = data.text?.trim();
      if (!text) {
        setAiError("模型返回为空");
        return;
      }
      if (s !== e2) {
        onChange(v.slice(0, s) + text + v.slice(e2));
      } else {
        onChange(v.slice(0, s) + text + v.slice(s));
      }
      const pos = s + text.length;
      requestAnimationFrame(() => {
        const el = taRef.current;
        if (el) el.selectionStart = el.selectionEnd = pos;
      });
    } catch {
      setAiError("网络或服务异常");
    } finally {
      setAiLoading(false);
    }
  }, [aiInstruction, onChange, value]);

  const toolbarBtn =
    "rounded px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800";
  const modeBtn = (active: boolean) =>
    `rounded px-2 py-1 text-xs ${
      active
        ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
        : toolbarBtn
    }`;

  return (
    <div className="mt-1 rounded-lg border border-zinc-300 dark:border-zinc-700">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-2 py-2 dark:border-zinc-700">
        <button type="button" onClick={() => setMode("edit")} className={modeBtn(mode === "edit")}>
          编辑
        </button>
        <button
          type="button"
          onClick={() => setMode("preview")}
          className={modeBtn(mode === "preview")}
        >
          预览
        </button>
        <div className="mx-1 h-4 w-px bg-zinc-200 dark:bg-zinc-700" />
        <button
          type="button"
          title="Notion 同款：# + 空格（井号后须有空格；无空格为标签）"
          onClick={() => insertSnippet("# 标题")}
          className={toolbarBtn}
        >
          H1
        </button>
        <button
          type="button"
          title="Notion 同款：## + 空格"
          onClick={() => insertSnippet("## 小标题")}
          className={toolbarBtn}
        >
          H2
        </button>
        <button
          type="button"
          title="无序列表（子级：行首加 2/4/6… 个空格再加 - ）"
          onClick={() => prefixCurrentLine(true)}
          className={`${toolbarBtn} inline-flex items-center gap-1 font-medium`}
        >
          <span aria-hidden>•</span>
          无序
        </button>
        <button
          type="button"
          title="有序列表"
          onClick={() => prefixCurrentLine(false)}
          className={`${toolbarBtn} inline-flex items-center gap-1 font-medium`}
        >
          <span aria-hidden className="tabular-nums text-[0.65rem]">
            1.
          </span>
          有序
        </button>
        <button type="button" onClick={() => insertSnippet("- 列表项")} className={toolbarBtn}>
          +一行
        </button>
        <button type="button" onClick={() => insertSnippet("**加粗**")} className={toolbarBtn}>
          加粗
        </button>
        <button
          type="button"
          onClick={() => insertSnippet("[链接文字](https://example.com)")}
          className={toolbarBtn}
        >
          链接
        </button>
        <button type="button" title="待办（GFM）" onClick={() => insertSnippet("- [ ] ")} className={toolbarBtn}>
          待办
        </button>
        <button type="button" title="引用块" onClick={() => insertSnippet("> ")} className={toolbarBtn}>
          引用
        </button>
        <button type="button" title="分隔线" onClick={() => insertSnippet("---")} className={toolbarBtn}>
          分隔
        </button>
        <button
          type="button"
          title="围栏代码块"
          onClick={() => insertSnippet("```\n\n```")}
          className={toolbarBtn}
        >
          代码
        </button>
        <div className="mx-1 h-4 w-px bg-zinc-200 dark:bg-zinc-700" />
        <button
          type="button"
          title="需配置 OPENAI_API_KEY，见 docs/ai-assistant.md"
          onClick={() => {
            setAiOpen((o) => !o);
            setAiError("");
            setMode("edit");
          }}
          className={`${toolbarBtn} font-medium text-violet-700 dark:text-violet-300`}
        >
          AI
        </button>
      </div>

      {aiOpen && (
        <div className="space-y-2 border-b border-zinc-200 bg-violet-50/60 px-3 py-3 text-xs dark:border-zinc-700 dark:bg-violet-950/30">
          <p className="text-zinc-600 dark:text-zinc-400">
            可选中一段再生成（替换选区）；不选中则在光标处插入。需在环境变量配置{" "}
            <code className="rounded bg-white/80 px-1 dark:bg-zinc-900">OPENAI_API_KEY</code>{" "}
           （Cursor 会员无对外 API，不能自动代填）。
          </p>
          <div className="flex flex-wrap gap-1.5">
            {AI_PRESETS.map(({ label, instruction }) => (
              <button
                key={label}
                type="button"
                onClick={() => {
                  setAiInstruction(instruction);
                  setAiError("");
                }}
                className="rounded-full border border-violet-200 bg-white px-2.5 py-1 text-violet-800 hover:bg-violet-100 dark:border-violet-800 dark:bg-zinc-900 dark:text-violet-200 dark:hover:bg-violet-950"
              >
                {label}
              </button>
            ))}
          </div>
          <textarea
            value={aiInstruction}
            onChange={(e) => setAiInstruction(e.target.value)}
            rows={2}
            placeholder="描述你想让 AI 做什么…"
            className="w-full rounded-lg border border-violet-200 bg-white px-2 py-1.5 text-zinc-900 outline-none focus:border-violet-400 dark:border-violet-900 dark:bg-zinc-950 dark:text-zinc-100"
          />
          {aiError && (
            <p className="text-red-600 dark:text-red-400">{aiError}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={aiLoading}
              onClick={() => void runAiAssist()}
              className="rounded-lg bg-violet-600 px-3 py-1.5 font-medium text-white hover:bg-violet-700 disabled:opacity-50 dark:bg-violet-500 dark:hover:bg-violet-400"
            >
              {aiLoading ? "生成中…" : "生成并插入"}
            </button>
            <button
              type="button"
              onClick={() => {
                setAiOpen(false);
                setAiError("");
              }}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-zinc-700 hover:bg-white dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              关闭
            </button>
          </div>
        </div>
      )}

      {mode === "edit" && slashOpen && (
        <div
          className="border-b border-zinc-200 bg-zinc-50 px-3 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-800/60"
          role="presentation"
        >
          <p className="mb-1.5 text-[0.65rem] font-medium text-zinc-500 dark:text-zinc-400">
            / 块命令（/ 可在已有文字前）· ↑↓ · Enter/Tab 插入 · Esc 取消
          </p>
          <ul className="max-h-40 space-y-0.5 overflow-y-auto overscroll-contain" role="listbox">
            {filteredSlash.length === 0 ? (
              <li className="rounded-md px-2 py-2 text-zinc-400">
                无匹配，继续缩小关键字或 Esc 取消
              </li>
            ) : (
              filteredSlash.map((cmd, i) => (
                <li key={cmd.id} role="presentation">
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === slashSelected}
                    className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-zinc-800 dark:text-zinc-100 ${
                      i === slashSelected
                        ? "bg-zinc-200 dark:bg-zinc-700"
                        : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    }`}
                    onMouseDown={(ev) => ev.preventDefault()}
                    onMouseEnter={() => setSlashSelected(i)}
                    onClick={() => applySlashCommand(cmd.prefix)}
                  >
                    <span>{cmd.label}</span>
                    <span className="shrink-0 font-mono text-[0.65rem] text-zinc-400">
                      {cmd.hint}
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}

      {mode === "edit" ? (
        <div className="relative rounded-b-lg bg-zinc-50/80 dark:bg-zinc-900/40">
          <div
            className="pointer-events-none absolute inset-0 overflow-hidden rounded-b-lg"
            aria-hidden
          >
            <div
              ref={editBackdropInnerRef}
              className="md-editor-syntax-backdrop box-border px-3 py-2 text-left text-sm font-normal leading-relaxed [overflow-wrap:anywhere]"
              dangerouslySetInnerHTML={{ __html: editBackdropHtml }}
            />
          </div>
          <textarea
            ref={taRef}
            value={value}
            onChange={handleTextAreaChange}
            onClick={(e) => {
              handleTextAreaSelect();
              syncEditBackdropScroll(e.currentTarget);
            }}
            onSelect={handleTextAreaSelect}
            onScroll={(e) => syncEditBackdropScroll(e.currentTarget)}
            onKeyDownCapture={handleTabCapture}
            onKeyDown={handleKeyDown}
            rows={rows}
            placeholder={placeholder}
            spellCheck={false}
            className="relative z-10 m-0 max-h-[min(70vh,32rem)] min-h-0 w-full resize-y overflow-y-auto whitespace-pre-wrap break-words rounded-b-lg border-0 bg-transparent px-3 py-2 text-left text-sm font-normal leading-relaxed text-transparent caret-zinc-900 outline-none placeholder:text-zinc-400/85 selection:bg-sky-500/30 [overflow-wrap:anywhere] dark:caret-zinc-200 dark:placeholder:text-zinc-500/85 dark:selection:bg-sky-400/25"
          />
        </div>
      ) : (
        <div className={`${markdownPreviewProseClass} ${markdownHeadingClass} rounded-b-lg px-3 py-3 text-sm`}>
          <div
            className="space-y-[1.15em]"
            dangerouslySetInnerHTML={{
              __html: previewHtml || "<p class='text-zinc-400'>暂无内容</p>",
            }}
          />
        </div>
      )}
    </div>
  );
}
