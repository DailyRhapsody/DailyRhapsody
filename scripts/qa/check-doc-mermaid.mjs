/**
 * 校验 Markdown 文档里的 mermaid 代码块语法。
 *
 * 背景：mermaid.parse() 在 Node 环境会因 DOMPurify 缺少 DOM 而抛
 * "DOMPurify.addHook is not a function"（与代码块语法无关）。因此本脚本
 * 不调用 mermaid 的渲染/解析，而是自行做两项可离线完成的检查：
 *   1. 每个块能被完整提取（围栏配对）
 *   2. 图类型声明合法，且节点/边声明的基本形态成立
 * 真正的渲染验证请在浏览器或 mermaid.live 中进行。
 *
 * 用法：node scripts/qa/check-doc-mermaid.mjs [file.md]
 */
import { readFileSync } from "node:fs";

const file = process.argv[2] ?? "README.md";
const md = readFileSync(file, "utf8");

// 逐行扫描提取，避免正则标志差异导致的漏提取
const blocks = [];
let inBlock = false;
let buf = [];
for (const line of md.split(/\r?\n/)) {
  if (!inBlock && line.trim() === "```mermaid") {
    inBlock = true;
    buf = [];
    continue;
  }
  if (inBlock && line.trim() === "```") {
    inBlock = false;
    blocks.push(buf.join("\n"));
    continue;
  }
  if (inBlock) buf.push(line);
}

console.log(`文件: ${file}`);
console.log(`提取 mermaid 块: ${blocks.length}${inBlock ? "  ⚠️ 有未闭合的块" : ""}\n`);

const KNOWN = [
  "flowchart", "graph", "sequenceDiagram", "classDiagram",
  "stateDiagram", "erDiagram", "journey", "gantt", "pie", "mindmap",
];

let ok = true;
blocks.forEach((src, i) => {
  const lines = src.split("\n").filter((l) => l.trim() !== "");
  const head = lines[0]?.trim() ?? "";
  const kind = head.split(/\s+/)[0];
  const problems = [];

  if (!KNOWN.includes(kind)) problems.push(`未知图类型: "${kind}"`);

  // 边声明形态：至少应有一条 --> 或 -.-> 或 ->> 之类的连接符
  const edgeCount = lines.filter((l) => /(-->|-\.->|->>|--x|--o|---)/.test(l)).length;
  if (edgeCount === 0) problems.push("未发现任何边声明");

  // 节点 id 含中文/空格但未用引号包裹，是最常见的渲染失败原因
  lines.forEach((l, idx) => {
    if (/^\s*(subgraph|classDef|class|style|linkStyle|click)\b/.test(l)) return;
    if (/^[A-Za-z0-9_]+\s*\[[^"\]]*[\u4e00-\u9fff][^"\]]*\]/.test(l)) {
      problems.push(`第 ${idx + 1} 行节点标签含中文但未加引号: ${l.trim().slice(0, 50)}`);
    }
  });

  if (problems.length === 0) {
    console.log(`  ✅ 块 ${i + 1}  ${kind}  (${lines.length} 行, ${edgeCount} 条边)`);
  } else {
    ok = false;
    console.log(`  ❌ 块 ${i + 1}  ${kind}`);
    problems.forEach((p) => console.log(`        ${p}`));
  }
});

console.log(`\n结果: ${ok ? "基本形态检查通过 ✅" : "发现问题 ❌"}`);
console.log("提示：完整渲染验证请在浏览器 / mermaid.live 中进行（Node 下 mermaid.parse 依赖 DOM）。");
process.exit(ok ? 0 : 1);
