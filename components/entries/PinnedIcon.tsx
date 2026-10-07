/** 置顶状态用的线形图钉，与文章元信息保持相同视觉权重。 */
export function PinnedIcon() {
  return (
    <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <g transform="rotate(35 12 12)">
        <path d="M9 3h6l-1 7 4 4v2H6v-2l4-4-1-7Z" />
        <path d="M12 16v5" />
      </g>
    </svg>
  );
}
