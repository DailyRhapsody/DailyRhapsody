"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 评论输入框的表情按钮：选中的 emoji 直接作为正文插入，与文字走同一条同步链路
 * （评论 content → Notion rich_text），不需要额外的 reaction 数据结构。
 *
 * 面板是自绘的常用表情网格，不引第三方 picker：一个评论框只需要几十个高频表情，
 * 引一个几百 KB 的库不划算。最近用过的存 localStorage，跟着浏览器走。
 */

const GROUPS: { label: string; items: string[] }[] = [
  {
    label: "笑脸",
    items: ["😀", "😄", "😁", "😂", "🤣", "😊", "🙂", "😉", "😍", "🤩", "😘", "😜", "🤔", "🤨", "😐", "😴"],
  },
  {
    label: "手势",
    items: ["👍", "👎", "👏", "🙌", "🤝", "✌️", "🤞", "👌", "🫶", "🙏", "💪", "👋", "🤙", "✋", "🖐️", "🫡"],
  },
  {
    label: "爱心",
    items: ["❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "💔", "💕", "💖", "💗", "💓", "💞", "💘", "💝"],
  },
  {
    label: "其它",
    items: ["🎉", "🎊", "🔥", "✨", "🌟", "💯", "✅", "❌", "⭐", "🌈", "☀️", "🌙", "🍀", "🎁", "📌", "💡"],
  },
];

const RECENT_KEY = "dr:emoji-recent";
const RECENT_MAX = 16;

/** 最近用过的表情只在打开面板时读：放 effect 里同步 setState 会触发级联渲染（lint 规则） */
function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX)
      : [];
  } catch {
    return [];
  }
}

export function CommentEmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  function toggle() {
    if (!open) setRecent(readRecent());
    setOpen(!open);
  }

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  function pick(emoji: string) {
    onPick(emoji);
    const next = [emoji, ...recent.filter((x) => x !== emoji)].slice(0, RECENT_MAX);
    setRecent(next);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      // 隐私模式等写入失败：只是没有最近记录
    }
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="absolute right-0 top-0 z-20">
      <button
        type="button"
        onClick={toggle}
        aria-label="插入表情"
        aria-expanded={open}
        title="插入表情"
        className="grid h-6 w-6 place-items-center rounded text-[0.9rem] leading-none text-zinc-400 transition-apple hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
      >
        🙂
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="选择表情"
          className="absolute bottom-full right-0 mb-1 max-h-[264px] w-[236px] overflow-y-auto rounded-xl border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
        >
          {recent.length > 0 && (
            <>
              <p className="px-0.5 pb-1 text-[0.62rem] text-zinc-400">最近</p>
              <div className="grid grid-cols-8 gap-0.5 pb-1.5">
                {recent.map((emoji) => (
                  <EmojiButton key={"r" + emoji} emoji={emoji} onPick={pick} />
                ))}
              </div>
            </>
          )}
          {GROUPS.map((group) => (
            <div key={group.label}>
              <p className="px-0.5 pb-1 text-[0.62rem] text-zinc-400">{group.label}</p>
              <div className="grid grid-cols-8 gap-0.5 pb-1.5">
                {group.items.map((emoji) => (
                  <EmojiButton key={group.label + emoji} emoji={emoji} onPick={pick} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EmojiButton({ emoji, onPick }: { emoji: string; onPick: (emoji: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onPick(emoji)}
      aria-label={`插入 ${emoji}`}
      className="grid h-6 w-6 place-items-center rounded text-[0.95rem] leading-none hover:bg-zinc-100 dark:hover:bg-zinc-800"
    >
      {emoji}
    </button>
  );
}
