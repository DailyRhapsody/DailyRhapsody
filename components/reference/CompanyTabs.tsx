"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useLang } from "@/components/LangProvider";

type TabKey = "intro" | "philosophy" | "master" | "author";

const TABS: { key: TabKey; num: string; label: string }[] = [
  { key: "intro", num: "01", label: "company.tabs.intro" },
  { key: "philosophy", num: "02", label: "company.tabs.philosophy" },
  { key: "master", num: "03", label: "company.tabs.master" },
  { key: "author", num: "04", label: "company.tabs.author" },
];

/**
 * 公司详情的四段：简介、哲学之剑、大师之剑、作者之剑。
 *
 * 四块都在服务端渲染，切 tab 只切可见性，不重新请求；这样首屏 HTML 仍有
 * 完整内容，分享与收录不吃亏。
 */
export function CompanyTabs({
  intro,
  philosophy,
  master,
  author,
}: {
  intro: ReactNode;
  philosophy: ReactNode;
  master: ReactNode;
  author: ReactNode;
}) {
  const { t } = useLang();
  const [active, setActive] = useState<TabKey>("intro");
  const pendingFocus = useRef<TabKey | null>(null);

  const select = (key: TabKey) => {
    setActive(key);
  };

  useEffect(() => {
    if (!pendingFocus.current) return;
    const key = pendingFocus.current;
    pendingFocus.current = null;
    document.getElementById(`company-tab-${key}`)?.focus();
  }, [active]);

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = TABS.findIndex((tab) => tab.key === active);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (current + 1) % TABS.length;
    else if (event.key === "ArrowLeft") nextIndex = (current - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = TABS.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    const next = TABS[nextIndex];
    pendingFocus.current = next.key;
    select(next.key);
  };

  const panels: Record<TabKey, ReactNode> = {
    intro,
    philosophy,
    master,
    author,
  };

  return (
    <div className="mt-8">
      <div
        role="tablist"
        aria-label={t("company.tabs.label")}
        className="rd-tabs flex gap-7 overflow-x-auto"
        onKeyDown={onTabKeyDown}
      >
        {TABS.map((tab) => {
          const selected = active === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              id={`company-tab-${tab.key}`}
              aria-selected={selected}
              aria-controls={`company-panel-${tab.key}`}
              data-active={selected ? "true" : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(tab.key)}
              className="rd-tab text-[0.82rem] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--rd-accent)]"
            >
              <span className="rd-tab-num">{tab.num}</span>
              <span>{t(tab.label)}</span>
            </button>
          );
        })}
      </div>

      {TABS.map((tab) => (
        <div
          key={tab.key}
          role="tabpanel"
          id={`company-panel-${tab.key}`}
          aria-labelledby={`company-tab-${tab.key}`}
          hidden={active !== tab.key}
          className={`pt-8 ${active === tab.key ? "rd-rise" : ""}`}
        >
          {panels[tab.key]}
        </div>
      ))}
    </div>
  );
}
