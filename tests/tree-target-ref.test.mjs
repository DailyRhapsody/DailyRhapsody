// node --test tests/tree-target-ref.test.mjs
//
// 思维大树里点叶子定位文章后，读者滚走，之后翻页、点时间轴、切标签都不能把读者拽回那篇文章。
//
// 旧写法有两处会拽回：
//  1. scrollToTreeTarget 在对齐期间一直把目标挂在 treeTargetRef 上，读者一滚就取消了对齐，
//     ref 却不清，定位 effect 每逢列表变化都再次命中；
//  2. 它往地址栏写 #entry-<id>，useEntries 的深链 effect 把它当成还没落地的分享锚点，
//     下一次翻页再把读者拉回来一次（时间轴跳转早就为此清掉残留锚点）。
// EntriesPageClient 是客户端大组件，仓库没有 DOM 测试环境，这里守源码里的不变式；
// 行为由本地 next dev + headless Chromium 实测。
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const src = fs.readFileSync("app/(feed)/blog/EntriesPageClient.tsx", "utf8");
const start = src.indexOf("const scrollToTreeTarget = useCallback(");
const end = src.indexOf("const handleTreeEntry = useCallback(", start);
const body = start >= 0 && end > start ? src.slice(start, end) : "";

test("找到目标即清空待定目标，对齐期间不再挂着它", () => {
  assert.ok(body, "找不到 scrollToTreeTarget");
  const found = body.indexOf("if (!el) return false;");
  const cleared = body.indexOf("treeTargetRef.current = null;");
  assert.ok(found >= 0 && cleared > found, "找到目标元素后必须清空 treeTargetRef");
  assert.doesNotMatch(body, /treeTargetRef\.current = id\b/, "对齐期间不能重新挂上待定目标");
});

test("不往地址栏写 #entry- 锚点，残留的旧锚点一并清掉", () => {
  assert.doesNotMatch(body, /replaceState\([^)]*#entry-/, "写进地址栏的锚点会被深链 effect 当成分享链接再定位一次");
  assert.match(body, /if \(window\.location\.hash\.startsWith\("#entry-"\)\) \{\s*window\.history\.replaceState\(window\.history\.state, "", window\.location\.pathname \+ window\.location\.search\);/);
});

test("待定目标只由树的点击设置，定位 effect 仍然靠它补载与定位", () => {
  assert.match(src, /const handleTreeEntry = useCallback\(\(id: string\) => \{[\s\S]*?treeTargetRef\.current = id;/);
  assert.match(src, /const id = treeTargetRef\.current;\s*\n\s*if \(!id \|\| loadingMore/);
});
