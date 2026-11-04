"use client";

import { useEffect } from "react";
import { ensureGate } from "@/lib/gate-handshake";

/**
 * 根布局挂载时预热门闸握手：本页没有受保护请求时也先握手，之后客户端跳转到有数据的页面不必再等 PoW。
 * 凭据有效（提示 cookie 在）时什么都不做。门闸状态与握手见 lib/gate-handshake.ts。
 */
export function GateClient() {
  useEffect(() => {
    void ensureGate();
  }, []);
  return null;
}
