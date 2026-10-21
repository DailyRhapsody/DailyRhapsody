"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useLang } from "@/components/LangProvider";

type TabKey = "intro" | "philosophy" | "master" | "author";

const TABS: { key: TabKey; label: string }[] = [
  { key: "intro", label: "company.tabs.intro" },
  { key: "philosophy", label: "company.tabs.philosophy" },
  { key: "master", label: "company.tabs.master" },
  { key: "author", label: "company.tabs.author" },
];

/**
 * 公司详情的四段：简介、哲学之剑、大师之剑、作者之剑。
 *
 * Apple 式分段控件；四块都在服务端渲染，切 tab 只切可见性。
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
    <>
      <div className="ap-tabs-bar">
        <div className="ap-tabs-inner">
          <div
            role="tablist"
            aria-label={t("company.tabs.label")}
            className="ap-segmented"
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
                  className="ap-segment focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ap-blue)]"
                >
                  {t(tab.label)}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="ap-content">
        {TABS.map((tab) => (
          <div
            key={tab.key}
            role="tabpanel"
            id={`company-panel-${tab.key}`}
            aria-labelledby={`company-tab-${tab.key}`}
            hidden={active !== tab.key}
            className={active === tab.key ? "ap-rise" : ""}
          >
            {panels[tab.key]}
          </div>
        ))}
      </div>
    </>
  );
}
