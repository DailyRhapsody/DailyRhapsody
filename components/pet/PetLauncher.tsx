"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { PixelAstronaut } from "@/components/pet/PixelAstronaut";
import { useAdminSession } from "@/hooks/useAdminSession";
import { isGateIssuingPath } from "@/lib/gate-pages";
import { getPetMode } from "@/lib/persona/config";

// 面板连同 marked / sanitize-html 首次打开时才加载，不拖累封面与首屏
const PetChatPanel = dynamic(() => import("@/components/pet/PetChatPanel").then((m) => m.PetChatPanel), {
  ssr: false,
});

/**
 * 右下角数字人入口。挂在根 layout：/entries 的翻转容器带 transform，
 * 放在页面树里 fixed 会变成相对容器定位；根 layout 跨路由不卸载，对话也不会丢。
 */
export function PetLauncher() {
  const mode = getPetMode();
  const pathname = usePathname();
  if (mode === "off") return null;
  // 只放在会签发握手的页面：404 等页面拿不到 dr_gate，请求对话接口只会被拒并记违规。
  // 封面虽然签发握手，但它是全屏沉浸页且会自动跳转，不放
  if (!pathname || pathname === "/" || !isGateIssuingPath(pathname)) return null;
  return mode === "owner" ? <OwnerOnly pathname={pathname} /> : <Launcher />;
}

/** 内测阶段只给登录后的自己看。按路由重查会话：登录后客户端跳回前台时根 layout 不会重挂 */
function OwnerOnly({ pathname }: { pathname: string }) {
  const { isAdmin, loading } = useAdminSession(pathname);
  if (loading || !isAdmin) return null;
  return <Launcher />;
}

function Launcher() {
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const [thinking, setThinking] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // 对话开着时在根节点打标记：左上角头像的呼吸灯据此换成彩色光环（globals.css 的 dr-pet-avatar-ring）
  useEffect(() => {
    const root = document.documentElement;
    if (open) root.dataset.petChat = thinking ? "thinking" : "open";
    return () => {
      delete root.dataset.petChat;
    };
  }, [open, thinking]);
  // 对话关闭时它的内容会变成 inert，焦点会掉到 body：交还给宠物按钮。
  // 等按钮恢复可见（窄屏对话打开时按钮隐藏，免得压住输入胶囊）再聚焦
  const close = useCallback(() => {
    const panel = document.querySelector('[role="dialog"][data-pet-chat]');
    const focusInPanel = !!panel?.contains(document.activeElement);
    setOpen(false);
    if (focusInPanel) requestAnimationFrame(() => buttonRef.current?.focus());
  }, []);

  return (
    <>
      {everOpened && <PetChatPanel open={open} onClose={close} onThinkingChange={setThinking} />}
      <button
        ref={buttonRef}
        type="button"
        data-pet-chat
        onClick={() => {
          setEverOpened(true);
          setOpen((v) => !v);
        }}
        aria-label={open ? "收起对话" : "和滕君的 AI 分身聊聊"}
        aria-expanded={open}
        // 不用 env(safe-area-inset-*)：页面没有 viewport-fit=cover，它恒为 0。宠物上线后 Safari 26
        // 顶栏下方出现白缝，这是当时全站唯一新增的 safe-area 引用，去掉无副作用
        style={{ bottom: "1.25rem", transitionProperty: "opacity, translate" }}
        // block + leading-none：去掉行盒基线余量，按钮高度稳定，不压到面板
        className={`group fixed right-4 z-[100] block rounded-2xl p-1.5 font-sans leading-none outline-offset-4 transition-apple hover:-translate-y-0.5 motion-reduce:hover:translate-y-0 sm:right-6 ${
          open ? "max-lg:invisible" : ""
        }`}
      >
        <PixelAstronaut scale={3} thinking={thinking} />
        {!open && (
          <span className="pointer-events-none absolute right-full top-1/2 mr-2 hidden -translate-y-1/2 whitespace-nowrap rounded-full bg-white/80 px-3 py-1.5 text-[13px] text-zinc-700 opacity-0 shadow-sm ring-1 ring-black/5 backdrop-blur-md transition-apple group-hover:opacity-100 dark:bg-zinc-900/80 dark:text-zinc-200 dark:ring-white/10 sm:block">
            和我聊聊
          </span>
        )}
      </button>
    </>
  );
}
