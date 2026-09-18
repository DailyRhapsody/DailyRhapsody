/* eslint-disable @next/next/no-img-element -- 头像库是本站静态 SVG，不需要优化器 */

/**
 * 访客评论头像：public/comment-avatars/ 下 36 张 Notionists 风格线稿（CC0，见同目录 LICENSE.md）。
 * 线稿是黑色透明底，深色模式也垫浅色圆底，否则看不见。
 */
export const COMMENT_AVATAR_COUNT = 36;

export function commentAvatarSrc(n: number): string {
  const i = Number.isInteger(n) && n >= 1 && n <= COMMENT_AVATAR_COUNT ? n : 1;
  return `/comment-avatars/${String(i).padStart(2, "0")}.svg`;
}

/** 随机取一个头像编号，避开 `except` */
export function randomCommentAvatar(except?: number): number {
  let n = 1 + Math.floor(Math.random() * COMMENT_AVATAR_COUNT);
  if (n === except) n = (n % COMMENT_AVATAR_COUNT) + 1;
  return n;
}

export function CommentAvatar({ n, className = "h-6 w-6" }: { n: number; className?: string }) {
  return (
    <img
      src={commentAvatarSrc(n)}
      alt=""
      aria-hidden
      loading="lazy"
      decoding="async"
      className={`shrink-0 select-none rounded-full bg-zinc-100 ring-1 ring-zinc-900/5 dark:bg-zinc-200 ${className}`}
    />
  );
}
