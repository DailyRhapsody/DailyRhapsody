"use client";

import { useState, type ReactNode } from "react";
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

  const select = (key: TabKey) => {
    setActive(key);
  };

  const panels: Record<TabKey, ReactNode> = {
    intro,
    philosophy,
    master,
    author,
  };

  return (
    <div className="mt-7">
      <div
        role="tablist"
        aria-label={t("company.tabs.label")}
        className="flex gap-5 overflow-x-auto border-b border-zinc-200 text-[0.82rem] dark:border-zinc-800"
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
              onClick={() => select(tab.key)}
              className={`-mb-px shrink-0 border-b-2 pb-2.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 ${
                selected
                  ? "border-zinc-900 font-medium text-zinc-900 dark:border-zinc-100 dark:text-zinc-50"
                  : "border-transparent text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              }`}
            >
              {t(tab.label)}
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
          className="pt-6"
        >
          {panels[tab.key]}
        </div>
      ))}
    </div>
  );
}
