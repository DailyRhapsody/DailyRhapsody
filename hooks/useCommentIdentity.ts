"use client";

import { useSyncExternalStore } from "react";
import { COMMENT_AVATAR_COUNT, randomCommentAvatar } from "@/components/entries/CommentAvatar";

/**
 * 访客评论身份（昵称 + 头像编号）：整页所有评论框共用一份并存 localStorage，
 * 在一篇里换了头像、填了昵称，别的评论框也跟着变，不会同一个人显示成两个人。
 */
const NAME_KEY = "dr:comment-name";
const AVATAR_KEY = "dr:comment-avatar";

type Identity = { name: string; avatar: number };

let identity: Identity | null = null;
const listeners = new Set<() => void>();

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 隐私模式等写不进去：只是下次不记得昵称 / 头像
  }
}

function current(): Identity {
  if (identity) return identity;
  const saved = Number(readLocal(AVATAR_KEY));
  const avatar =
    Number.isInteger(saved) && saved >= 1 && saved <= COMMENT_AVATAR_COUNT ? saved : randomCommentAvatar();
  writeLocal(AVATAR_KEY, String(avatar));
  identity = { name: readLocal(NAME_KEY) ?? "", avatar };
  return identity;
}

function set(next: Partial<Identity>) {
  identity = { ...current(), ...next };
  if (next.name !== undefined) writeLocal(NAME_KEY, identity.name);
  if (next.avatar !== undefined) writeLocal(AVATAR_KEY, String(identity.avatar));
  for (const l of listeners) l();
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

const SERVER: Identity = { name: "", avatar: 1 };

export function useCommentIdentity() {
  const id = useSyncExternalStore(subscribe, current, () => SERVER);
  return {
    name: id.name,
    avatar: id.avatar,
    setName: (name: string) => set({ name }),
    shuffleAvatar: () => set({ avatar: randomCommentAvatar(id.avatar) }),
  };
}
