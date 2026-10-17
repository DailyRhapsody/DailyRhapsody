/**
 * 数字人 agent 模式的工具目录（v1：全部只读站内）。
 *
 * 为什么单独一个文件：这份 schema 是「模型看得到的协议」——
 * agent 循环把它序列化成请求里的 tools 参数；工具实现（tool-runners.ts）
 * 按同一份 ToolId 穷举登记，漏一个就编译失败（与 skills / skill-runners 同一套机制）。
 *
 * 安全纪律（与 tests/persona-skills.test.mjs 的依赖禁区守卫配套）：
 * 工具数据一律由路由层传入「已过滤的可见集合」；本目录与实现都不读缓存、
 * 不碰人设包与鉴权。访客会话里不存在任何写工具——这是注册层的事实，不靠提示词约束。
 */

export type ToolId = "search_blog" | "read_article" | "blog_stats";

export type ToolSchema = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "search_blog",
      description:
        "全文检索我写过的公开文章与笔记，返回候选清单（标题、日期、站内链接、片段与 id）。需要事实依据时先用它；一次没有命中的话可以换关键词再检索。",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "检索关键词，中文即可" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_article",
      description:
        "按 id 读取一篇公开文章或笔记的全文（id 必须来自 search_blog 的结果或上文片段给出的链接）。片段信息不足时用它读全文，不要凭片段猜。",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "search_blog 返回的 id" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "blog_stats",
      description: "查看博客概况统计：总篇数、各年篇数、最近几篇、常用标签。回答篇数、日期类问题时用它核对，不要估算。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
] as const satisfies readonly ToolSchema[];

type ToolName = (typeof TOOL_DEFS)[number]["function"]["name"];
type AssertTrue<T extends true> = T;
// 目录（schema）与 ToolId 联合必须严格互覆盖：任何一边加了新工具而另一边没跟上，编译失败
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- 编译期探针：只在类型层消费，运行时不出现
type _ToolsCover = AssertTrue<
  ToolId extends ToolName ? (ToolName extends ToolId ? true : false) : false
>;

/**
 * 控制字符与隐形字符一并清洗（入口与工具结果双向）：格式字符（Cf）、Default_Ignorable
 * 属性（含 U+FEFF/BOM、零宽、bidi 控制、软连字符、Hangul Filler 等）、变体选择符与 Tag 区。
 * 手写区间清单会漏（2026-10-17 对抗复核实测：U+FEFF 与 C0/C1 控制符曾穿透），改用属性类；
 * \t\n\r 这类正常排版字符保留（\p{Cc} 整个包含它们，故按区间手工排除）。
 */
const INVISIBLE =
  /[\p{Cf}\p{Default_Ignorable_Code_Point}\uFE00-\uFE0F\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, "");
}

/** 工具结果按不可信输入包装；内容里的伪造闭合标签先中和，防止提前"关掉"作用域 */
// 带 '>' 的整标签优先整体替换；不带 '>' 的悬空闭合标签（同样能骗过模型的边界阅读）也要中和
const UNTRUSTED_TAG = /<\/?untrusted_tool_result[^>]*>|<\/?untrusted_tool_result/gi;

/** source 只保留工具名的合法字符集：未登记工具名来自模型，可含引号与尖括号，绝不能拼进结构 */
function safeSource(source: string): string {
  const s = source.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  return s || "unknown";
}

export function wrapUntrusted(source: string, payload: string): string {
  const safe = stripInvisible(payload).replace(UNTRUSTED_TAG, "（边界标签，已中和）");
  return `<untrusted_tool_result source="${safeSource(source)}">\n${safe}\n</untrusted_tool_result>`;
}
