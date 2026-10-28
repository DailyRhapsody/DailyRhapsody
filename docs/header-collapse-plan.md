# 博客顶栏「先收缩、后滚动」改造方案（待评审）

> 基线：`origin/main` @ `de1cf5c`。本文只是方案，未改动代码。
> 涉及文件：`components/StickyProfileHeader.tsx`、`lib/layout-constants.ts`，以及依赖 `data-return-to-top` 的 `components/entries/ScrollTimeline.tsx`、`hooks/useEntries.ts`。

## 1. 目标

1. 头图和页面是一个整体：头图收缩期间，正文顶边始终贴着头图底边，两者同速上移，中间没有相对位移。
2. 头图从 260px 收到 56px 的过程，完全由滚动量驱动；收完之后，正文才开始在 56px 顶栏下方正常滚动。
3. 往回滚时顺序相反：正文先回到顶部，头图再随滚动展开。
4. 保留原生滚动：触控板惯性、iOS 惯性和回弹、键盘、滚动条、锚点跳转都照常工作。
5. 轻微滚动、停手后不抖、不漂移。

## 2. 现状与问题

### 2.1 现有实现（`StickyProfileHeader.tsx`）

| 位置 | 内容 |
|---|---|
| L298–311 | 监听 `window.scroll`，按 rAF 节流 `setScrollY(window.scrollY)` |
| L357–367 | `height = nearTop(scrollY<28) ? 260 : max(56, 260 - scrollY)`；`isCollapsed = scrollY >= 214` |
| L419–424 | `<header class="sticky top-0 ... transition-[height] duration-300" style="height:{height}px">` |
| L175–295 | 回顶动画：第一阶段 `scrollTo` 回到 0（头图保持 56px），第二阶段用 rAF 把高度从 56 展开到 260；期间设置 `overflow-anchor:none` 和 `data-return-to-top` |

### 2.2 问题一：头图与正文割裂（几何推导，尚未逐帧实测）

头图是 `sticky top-0`，高度会变化，而且仍占文档流。滚动 `y`（0 ≤ y ≤ 204）时：

- 头图在屏幕上的底边：`260 − y`
- 正文在文档里的起点：`260 − y`（头图变矮，正文上移）
- 正文在屏幕上的顶边：`(260 − y) − y = 260 − 2y`

正文上移速度是头图收缩速度的两倍，会钻到头图下面，看起来就是“头图在收、页面也在滚”。

### 2.3 问题二：轻滑后持续抖动、页面自己上移（已在 WebKit 中复现）

测试环境：本地 dev（干净的 `origin/main` worktree），Playwright WebKit 2336，与 Safari 同一引擎，但不是 Safari.app。先停在半收缩位置，用 2–3px 的滚轮轻滑，逐帧记录 4 秒。

| 条件 | 结果 |
|---|---|
| 现状 | 起点 60 → 先掉到 30，再在 34↔35 间来回跳；头图在 225/226px 间抖；停手后 4 秒内仍有 28 次 scroll 事件 |
| 加 `html{overflow-anchor:none}` | 60 → 69，停在实际滚到的位置；停手后 0 次事件 |
| 去掉高度 `transition` | 仍异常 |
| 去掉 `scroll-behavior:smooth` | 仍抖，停手后 56 次事件 |

不同起点下，现状都会被“吃掉一半”：40 → 约 4，100 → 50，150 → 75。关掉锚定后，位置都保持不变。

**机制**：滚动改高度 → 高度改文档布局 → 浏览器滚动锚定修正 `scrollTop` → 又触发 scroll 改高度。这是一个反馈闭环。根因是**头图高度参与文档布局**；`overflow-anchor:none` 只能切断其中一个环节。

### 2.4 历史尝试

2026-04-11 的 `b39c2a1` 用 `virtualScroll` 实现过“先收缩后滚动”：在 `wheel` / `touchmove` 上 `preventDefault`，自己累加滚动量来驱动头图。同日 `f7fcb7f` 整体回退。拦截输入会破坏原生惯性，触控板、iOS、键盘、滚动条也都要单独处理。本方案不采用这条路。

## 3. 方案：固定占位 + 负 top 的 sticky

### 3.1 核心结构

```
<header  sticky; top:-204px; height:260px（固定）>   ← 在文档里永远占 260px
  <div 背景层  absolute inset-0 ...>               ← 视觉效果见 3.3
  <div 展开态内容  ...>
  <div 收起态 pill  absolute bottom-0 h-56px ...>
</header>
<正文 ...>
```

- `header` 在文档流里的高度固定为 260px，不再随滚动变化。页面总高度和正文起点都恒定，滚动锚定没有可修正的对象，反馈闭环从根本上消失。
- `position: sticky; top: -204px`（`-HEADER_COLLAPSE_RANGE`）：
  - `0 ≤ y ≤ 204`：sticky 还没触发，头图和正文作为普通文档一起上移，二者的相对位置恒为 0。
  - `y > 204`：头图停在 `top = -204px`，屏幕上只露出底部 56px，正文继续在它下面滚动。
- 收缩过程不需要任何 JS 控制布局，完全由浏览器原生滚动完成，惯性和回弹不受影响。

### 3.2 收起态布局

- 收起态 pill（头像 + 昵称 + 左右回顶按钮）固定在 `header` 内部的 `bottom: 0; height: 56px`，与 sticky 后可见的那一条对齐。
- 展开态内容（大头像 + 昵称 + 签名）放在 header 下部，随整体上移；进度大于约 0.6 时淡出。

### 3.3 进度与视觉效果

- `progress = clamp(scrollY / 204, 0, 1)`：只驱动透明度和变换，不改任何布局属性。
- 用 CSS 变量 `--hp` 承载进度：在 scroll 事件里用 rAF 写 `header.style.setProperty('--hp', p)`，不经 React state，避免每帧重渲染。
- 写入时机：scroll 事件触发的那一帧读取 `scrollY` 并立即写入。WebKit 的 sticky 是合成层滚动，进度属性只影响透明度，即使落后一帧也不会出现空隙或重叠。
- 视觉映射：
  - 展开态：`opacity = 1 - smoothstep(0.45, 0.8, p)`，`translateY = p * 8px`
  - 收起态：`opacity = smoothstep(0.75, 1, p)`；`p < 1` 时设置 `inert` 和 `pointer-events:none`
  - 背景：可选视差 `translateY(p * 60px)`，让收缩更有层次（可不做）
- `isCollapsed` 仍保留为 React state，只在跨越阈值时更新（用于 `inert` / `aria-hidden`），不会每帧渲染。
- 去掉 `transition-[height] duration-300` 和 `nearTop < 28` 的跳变。

### 3.4 圆角与阴影

- 现状 `rounded-b-2xl` 在固定 260px 的盒子上：收起时可见的是底部 56px，圆角仍在底边，表现与现在一致。
- 头图底边原来会因高度变化而移动；现在位置固定，相对正文不变，视觉上更稳定。

### 3.5 回顶（点击收起态 pill）

新结构下，滚到 0 时头图自然完全展开，回顶就是一次滚动：

- 用 rAF 驱动 `scrollTo`，沿用现有 `easeInOutCubic` 和时长公式 `min(1400, 400 + 200·ln(1 + y/200))`。
- 不再分两个阶段，也不需要手动设置头图高度和 crossfade：滚动经过 204 → 0 这一段时，进度变量会自然完成过渡。
- 保留 `data-return-to-top` 标记，`ScrollTimeline` 和 `useEntries` 中对它的等待逻辑不变；去掉 `overflow-anchor:none` 的设置与恢复（不再需要）。
- 尊重 `prefers-reduced-motion`：直接 `scrollTo(0)`。
- 用户在回顶途中滚轮、触摸或按键时中止动画（现状不可中断；改为可中断需确认 `ScrollTimeline` 的 `HEADER_WAIT_MS` 等待逻辑仍成立）。

### 3.6 依赖头图高度的其他逻辑

| 位置 | 依赖 | 影响 |
|---|---|---|
| `EntryCard` / `MomentsTab` / `ReferenceFeed` 的 `scroll-mt-24`（96px） | 锚点落点需要避开收起态顶栏（56px） | 不变：收起态可见高度仍为 56px |
| `ScrollTimeline.scrollToEntry` | 按目标实时位置逐帧插值 | 不变；文档布局变稳后结果更准 |
| `ScrollTimeline` 阅读线 = `scrollMarginTop + 16` | 同上 | 不变 |
| `lib/layout-constants.ts` | `HEADER_EXPANDED_H` / `HEADER_COLLAPSED_H` / `HEADER_COLLAPSE_RANGE` | 改用这些常量替换 `StickyProfileHeader` 里手写的 260/56/204 |
| `FeedShell` 上方卡片区 | 在 header 之后 | 不变 |

### 3.7 边界情况

| 情况 | 处理 |
|---|---|
| 内容短于一屏、滚不到 204px | **已确认接受**：头图只收缩一部分，正文始终贴着头图底边；不补最小高度，也不把进度改成按“实际可滚距离”归一化 |
| 刷新时浏览器恢复滚动位置 | 首帧同步计算 `--hp`，避免闪一下展开态 |
| iOS 回弹（`scrollY < 0`） | 进度 clamp 到 0；头图随回弹下拉，属原生行为 |
| 横向 tab 切换（博客 / 动态 / 参考） | header 不重挂载，进度变量照常 |
| 深色模式、`forced-colors` | 只改透明度和变换，不影响 |
| 窄屏 | 高度常量不变；如以后窄屏需要不同高度，再把常量改成 CSS 变量 |

## 4. 备选方案与取舍

| 方案 | 做法 | 结论 |
|---|---|---|
| A. 最小补丁 | 现状基础上加 `overflow-anchor:none` | 能消除抖动，**修不好割裂**（正文仍以两倍速上移） |
| B. 拦截输入（`virtualScroll`） | wheel/touch 上 `preventDefault`，自己累计滚动量 | 2026-04 做过并回退；破坏原生惯性，键盘和滚动条要另做 |
| C. 固定占位 + 负 top sticky（本方案） | 布局不变，视觉由进度变量驱动 | 原生滚动、无闭环，改动集中在一个组件 |
| D. CSS Scroll-driven Animations | `animation-timeline: scroll()` 驱动透明度 | Safari 支持度需核实；可作为第 3.3 节的增强，结构仍是 C |

## 5. 验证计划

### 5.1 自动化（Playwright WebKit，本地 dev）

逐帧记录 `scrollY`、头图底边、正文顶边、scroll 事件数。

1. **一体性**：`0 ≤ y ≤ 204` 内每帧满足 `|正文顶边 − 头图底边| ≤ 1px`；`y > 204` 时头图底边恒为 56。
2. **轻滑稳定**：起点 40/60/100/150/200，滚轮 2–3px，上下各一次；停手 300ms 后 scroll 事件数为 0，`scrollY` 不再变化。
3. **大幅滚动**：一次滚 600px，再回到 0，头图状态与位置一致。
4. **回顶**：从 1500px 点击 pill，结束时 `scrollY = 0`，展开态可见；中途滚轮可中止。
5. **锚点**：`/blog#entry-<id>` 深链和时间轴跳转的落点不变（文章顶边 = 96px）。

### 5.2 手动

- Safari.app（macOS）：触控板轻滑、快滑惯性、键盘、拖滚动条。
- iPhone Safari：轻滑停手、快滑惯性、顶部回弹。
- Chrome：回归一遍。

### 5.3 不在本次范围

- 顶栏视觉风格（颜色、背景图、头像尺寸）不改。
- BGM 自动播放与头像旋转逻辑不动。

## 6. 风险

| 风险 | 缓解 |
|---|---|
| WebKit 中 sticky 加负 `top` 的合成或抖动表现 | 先做最小原型，在 Safari.app 和 iPhone 上实测后再完整实现 |
| 回顶动画可中断后，`ScrollTimeline` 的等待逻辑出现竞态 | 保留标记语义；中止时立即清除标记，并补一条测试 |
| 进度写 CSS 变量时首帧闪烁 | 在 `useLayoutEffect` 里同步写一次 |
| `header` 外层容器有 `overflow` 或 `transform`，导致 sticky 失效 | 实现前核对 `FeedShell` / `(feed)/layout.tsx` 的祖先样式 |

## 7. 待评审问题

1. 收起态的 56px 条是否必须与现在完全一致（左右回顶区、居中头像昵称）？
2. 回顶改为可中断是否接受？
3. 背景视差要不要做？
4. 内容不足一屏时头图收不完，是否需要给页面补最小高度？

## 8. 已确认决策（2026-10-19）

- 短内容：接受“头图收不完，正文在 260px 以下”；不补最小高度，不按实际可滚距离重算进度。
- 收起态 56px 条：保持现有布局（左右回顶区、居中头像昵称）。
- 背景视差：首版不做，先保证一体性和稳定性。
- 回顶：首版保持“动画期间不可中断”，避免与 `ScrollTimeline` 的 `data-return-to-top` 等待逻辑产生竞态；后续单独评估可中断。

## 9. 交叉评审记录

评审来源：DeepSeek + OpenRouter 独立模型；Claude Code CLI 因当前组织禁用订阅未能运行。评审对象是本文，不是已实现代码。

### 9.1 已在 WebKit 原型验证

用最小静态原型（固定 260px header、`sticky top:-204px`、`--hp` 只驱动 opacity/transform）在 Playwright WebKit 2336 中测：

| scrollY | header bottom | main top | 结论 |
|---:|---:|---:|---|
| 0 | 260 | 260 | 贴合 |
| 1 | 259 | 259 | 贴合 |
| 100 | 160 | 160 | 贴合 |
| 203 | 57 | 57 | 贴合 |
| 204 | 56 | 56 | 贴合 |
| 205 | 56 | 55 | 正文开始从收起态顶栏下方穿过 |
| 300 | 56 | -40 | 正常滚动 |

- 0–204px 内每一帧 `main top == header bottom`，没有两倍速。
- `--hp` 在 2px 步进的 20 个 rAF 采样中与 `scrollY/204` 一致，没有观察到滞后。
- 短页（最大可滚 100px）：滚到 100px 时 header bottom/main top 都是 160px，头图保持部分收缩，没有额外空白或错位。

### 9.2 评审提出的、实现时必须处理的问题

1. **回顶状态机**：`data-return-to-top` 必须保留；只移除 `StickyProfileHeader` 里的 `overflow-anchor:none`。`ScrollTimeline.scrollToEntry` 自己那套 `overflowAnchor` 要保留，并在注释里说明用途。
2. **`inert` 与透明度对齐**：收起态 pill 在 `p > 0.75` 就开始可见；`inert` 不能等到 `p = 1` 才解除，否则会出现“看得到、点不了”的区间。建议 `p > 0.75` 时解除 `inert`，并保留 `pointer-events` 控制。
3. **深链要分两种起点测**：从 `y=0` 和从 `y>204` 分别跳到文章，连续 3 帧落点应稳定在 `scroll-mt-24`（96px）。
4. **祖先 sticky 检查**：代码层面 `app/layout.tsx`、`(feed)/layout.tsx`、`FeedShell` 根节点未发现 `overflow`/`transform`/`filter`；实现前仍应在浏览器里打印 header 的完整祖先链 computed style，排除 `contain` 等隐性包含块。
5. **`--hp` 首帧**：在 `useLayoutEffect` 同步写一次，避免刷新恢复滚动位置时闪展开态。
6. **`--hp` 约束**：只允许驱动 `opacity` / `transform` / `filter`；禁止驱动 `height` / `margin` / `top` / `padding`，否则滚动锚定闭环会回来。

### 9.3 未验证项

- 真实 Safari.app、iPhone Safari 的负 `top` sticky 和触控板惯性。
- 实际博客组件接入后的锚点、时间轴跳转、回顶状态机。
- 滚动条拖动、键盘滚动、页面短内容时的最终视觉（半收缩状态的展开态/pill 交叉淡入是否可接受）。
