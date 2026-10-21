import type { Lang } from "@/lib/i18n";

const COPY = {
  zh: {
    kicker: "判断顺序",
    title: "先定层，再判断",
    sub: "六层结构先找主导层，再沿因果链落到四行判断。任何单层都不当唯一根。",
    layers: "六层结构",
    layersHint: "哪一层解释力最强？",
    pick: "主导层候选，随公司变化",
    layersData: [
      ["01", "世界体系 / 地缘", "霸权 · 意识形态 · 供应链"],
      ["02", "国家 / 发展阶段", "产业政策 · 地方竞争 · 转型"],
      ["03", "文化 / 合法性", "面子 · 权威 · 叙事"],
      ["04", "产权 / 组织", "所有权 · 实权 · 家族"],
      ["05", "技术 / 物质", "技术路线 · 路径依赖"],
      ["06", "个体 / 位置", "身份 · 风险收益 · 退出"],
    ],
    chain: "因果链",
    chainHint: "结构如何塑造产品",
    nodes: [
      ["世界体系 / 国家政策 / 文化 / 发展阶段", "外部结构设定选择集"],
      ["产权 / 权力", "谁拥有、谁控制、谁否决"],
      ["目的 / 资源分配", "预算、人事、信息、时间"],
      ["技术 / 产品", "路线、组合、节奏"],
      ["十年位置", "结果与下一轮结构"],
    ],
    feedback: "技术/产品结果反过来改变权力与合法性",
    verdicts: "四行判断",
    verdictsHint: "同一张卡，四个断面",
    verdictData: [
      ["01", "主导层", "哪一层解释力最强"],
      ["02", "公司", "资产与经营质量"],
      ["03", "目的", "为谁服务，产品是手段还是目的"],
      ["04", "位置", "外部人最高可及位置"],
    ],
    foot: "四问分开作答，由同一条链连接。公司值得投、家族不想做产品、作者不适合去，可以同时成立。",
  },
  en: {
    kicker: "Judgment order",
    title: "Locate the layer first",
    sub: "Find the dominant layer among the six, then follow the causal chain into four verdicts. No single layer is treated as the only root.",
    layers: "Six layers",
    layersHint: "Which layer explains most?",
    pick: "Dominant layer varies by company",
    layersData: [
      ["01", "World-system / geopolitics", "Hegemony · ideology · supply chains"],
      ["02", "State / development stage", "Industrial policy · local competition · transition"],
      ["03", "Culture / legitimacy", "Face · authority · narrative"],
      ["04", "Ownership / organization", "Property · real power · family"],
      ["05", "Technology / materiality", "Technical route · path dependence"],
      ["06", "Individual / position", "Identity · risk-reward · exit"],
    ],
    chain: "Causal chain",
    chainHint: "How structure shapes product",
    nodes: [
      ["World-system / state policy / culture / development", "External structure sets the choice set"],
      ["Ownership / power", "Who owns, controls and vetoes"],
      ["Purpose / resource allocation", "Budget, people, information, time"],
      ["Technology / product", "Route, portfolio, cadence"],
      ["Ten-year position", "Outcome and the next structure"],
    ],
    feedback: "Technology and product outcomes feed back into power and legitimacy",
    verdicts: "Four verdicts",
    verdictsHint: "One card, four sections",
    verdictData: [
      ["01", "Dominant layer", "Which layer explains most"],
      ["02", "Company", "Asset and operating quality"],
      ["03", "Purpose", "Who is served; product as means or end"],
      ["04", "Position", "Highest accessible position for an outsider"],
    ],
    foot: "The four questions are answered separately and linked by one chain. A company can be worth studying, the family may not want to build products, and the author may still not fit.",
  },
} as const;

export function AuthorSwordFlow({ lang }: { lang: Lang }) {
  const c = COPY[lang];

  return (
    <div className="mt-2 w-full max-w-[680px] rounded-[18px] border border-[var(--ap-border)] bg-[var(--ap-surface-2)] p-4 text-left">
      <div className="flex items-baseline justify-between gap-3">
        <p className="ap-eyebrow">{c.kicker}</p>
        <p className="text-[10px] text-[var(--ap-tertiary)]">{c.title}</p>
      </div>
      <p className="mt-1 max-w-[36rem] text-[13px] leading-[1.6] text-[var(--ap-secondary)]">
        {c.sub}
      </p>

      <div className="mt-3 grid gap-3 md:grid-cols-[1.02fr_1fr]">
        <section aria-label={c.layers}>
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-[10px] font-semibold tracking-[0.12em] text-[var(--ap-tertiary)]">
              01 {c.layers}
            </p>
            <p className="text-[10px] text-[var(--ap-tertiary)]">{c.layersHint}</p>
          </div>
          <p className="mt-1 flex items-center gap-1.5 text-[10px] text-[var(--ap-blue)]">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--ap-blue)]" />
            {c.pick}
          </p>
          <div className="mt-2 space-y-1">
            {c.layersData.map(([n, title, desc]) => (
              <div
                key={n}
                className="flex gap-2 rounded-[10px] border border-[var(--ap-border)] px-2 py-1.5"
              >
                <span className="w-4 shrink-0 pt-px text-[9px] font-semibold text-[var(--ap-tertiary)]">
                  {n}
                </span>
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold leading-[1.35] text-[var(--ap-text)]">
                    {title}
                  </p>
                  <p className="mt-0.5 text-[10px] leading-[1.35] text-[var(--ap-secondary)]">
                    {desc}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section aria-label={c.chain}>
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-[10px] font-semibold tracking-[0.12em] text-[var(--ap-tertiary)]">
              02 {c.chain}
            </p>
            <p className="text-[10px] text-[var(--ap-tertiary)]">{c.chainHint}</p>
          </div>
          <div className="mt-2">
            {c.nodes.map(([title, desc], index) => (
              <div key={title}>
                <div className="rounded-[10px] border border-[var(--ap-border)] px-2 py-1.5">
                  <p className="text-[11px] font-semibold leading-[1.35] text-[var(--ap-text)]">
                    {title}
                  </p>
                  <p className="mt-0.5 text-[10px] leading-[1.35] text-[var(--ap-secondary)]">
                    {desc}
                  </p>
                </div>
                {index < c.nodes.length - 1 ? (
                  <div className="flex h-3 items-center justify-center text-[10px] text-[var(--ap-tertiary)]" aria-hidden>
                    ↓
                  </div>
                ) : null}
              </div>
            ))}
            <p className="mt-2 border-l-2 border-[var(--ap-blue)] pl-2 text-[10px] leading-[1.45] text-[var(--ap-secondary)]">
              ↺ {c.feedback}
            </p>
          </div>
        </section>
      </div>

      <section className="mt-3 rounded-[14px] border border-[var(--ap-border)] bg-[var(--ap-surface-3)] p-3" aria-label={c.verdicts}>
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-[10px] font-semibold tracking-[0.12em] text-[var(--ap-tertiary)]">
            03 {c.verdicts}
          </p>
          <p className="text-[10px] text-[var(--ap-tertiary)]">{c.verdictsHint}</p>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {c.verdictData.map(([n, title, desc]) => (
            <div key={n} className="rounded-[10px] border border-[var(--ap-border)] bg-[var(--ap-surface-2)] p-2">
              <p className="text-[9px] text-[var(--ap-tertiary)]">{n}</p>
              <p className="mt-0.5 text-[11px] font-semibold text-[var(--ap-text)]">{title}</p>
              <p className="mt-0.5 text-[10px] leading-[1.35] text-[var(--ap-secondary)]">{desc}</p>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[10px] leading-[1.45] text-[var(--ap-secondary)]">{c.foot}</p>
      </section>
    </div>
  );
}
