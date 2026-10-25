// 时间轴悬浮框第二行优先使用 Notion Name，不再拿正文第一句顶替。
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    return next(
      specifier.startsWith("@/")
        ? new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href
        : specifier,
      context
    );
  },
});
after(() => hooks.deregister());

const { entryTimelineRows } = await import("../components/entries/timelineRows.ts");
const { buildEntryOutline } = await import("../lib/entry-outline.ts");

test("时间轴第二行优先用 Notion Name", () => {
  const rows = entryTimelineRows([
    {
      id: "a",
      at: "2026-10-13T12:00:00",
      words: 20,
      name: "机器人平台的架构思考",
      excerpt: "这是正文第一句话…",
    },
  ]);
  assert.equal(rows[0].line2, "机器人平台的架构思考");
  assert.ok(rows[0].label.includes("机器人平台的架构思考"));
});

test("旧缓存没有 Name 时仍回退正文摘要", () => {
  const rows = entryTimelineRows([
    { id: "b", at: "2026-10-13T12:00:00", words: 20, excerpt: "旧摘要…" },
  ]);
  assert.equal(rows[0].line2, "旧摘要…");
});

test("大纲从 Diary.name 传递 Name", () => {
  const outline = buildEntryOutline([
    {
      id: "c",
      date: "2026-10-13",
      publishedAt: "2026-10-13T12:00:00",
      name: "产品选型逻辑",
      summary: "正文第一句话。",
    },
  ]);
  assert.equal(outline[0].name, "产品选型逻辑");
});
