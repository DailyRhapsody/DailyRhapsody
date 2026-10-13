/**
 * 云图屏的排布算法（纯函数，无 React 依赖，便于单测）。
 *
 * 拆成独立模块是为了可单测：这块排布踩过太多坑（见下方函数注释里那三版失败的尝试）。
 * 组件侧的排版约束见 components/entries/ReadingCloudScreen.tsx。
 */

/** 字号区间：每屏 3~4 个词，首名 15px、末名 11px */
const MIN_PX = 11;
const MAX_PX = 15;
/**
 * 长词降字号的硬下限。正常数据的字号区间是 MIN_PX~MAX_PX，只有单词宽度就超过
 * 整个画布时才往下压，压到这个值为止（再小就无法辨认，宁可让它贴边裁剪）。
 */
const HARD_MIN_PX = 9;
/**
 * 一屏最多容纳的词数。这是**几何约束**而不是展示偏好：
 * 126 × 106 的画布上，5 个同长中文词的词盒面积已超过画布，硬分离无法把它们
 * 全部推开（实测 5×8 字时残留 2 对约 2.7px 盒重叠）。
 * 上游 `lib/weread.ts` 已把每屏取词数限到 3~4，这里再兜一层，
 * 免得哪天有人调大上限后云图悄悄开始压字。超出部分直接丢弃。
 */
const MAX_WORDS_PER_CLOUD = 4;
/**
 * 碰撞盒的额外留白。
 * 水平方向：估宽对汉字与全角标点是准的（实测误差 0），但**对拉丁字母与 emoji 会低估**
 * （15px 的 `@@@@@@@@` 估 66px、实测 122px），所以横向多留几像素当作缓冲。
 * 垂直方向正文只有一两行，留太多会把可用区占满、后面的词无处可去，因此只留 2px。
 */
const BOX_PAD_X = 4;
const BOX_PAD_Y = 2;
/** 触边后的回退余量 */
const EDGE_PAD = 1;

export type CloudPlacement = {
  name: string;
  note: string;
  /** 词盒左上角相对可用区的位置 */
  x: number;
  y: number;
  fontSize: number;
  /**
   * 绿色档位：1 最深（首名）、2 中间、3 最浅（末名）。
   * 对应色值见 `components/entries/ReadingCloudScreen.tsx` 的 `SHADE_CLASS`。
   */
  shade: 1 | 2 | 3;
  bold: boolean;
};

/** 名次 → 字号：首名 MAX_PX，末名 MIN_PX，线性递减 */
function fontPx(rank: number, total: number): number {
  if (total <= 1) return MAX_PX;
  return Math.round(MAX_PX - (MAX_PX - MIN_PX) * (rank / (total - 1)));
}

/**
 * 名次 → 绿色档位。
 *
 * 早先用「同一色 + 递减透明度」表达层级，实测白底上末名只有 2.21:1 对比度，
 * 排在最后的词几乎读不清；而且这套主题色在白底上无论怎么调透明度都到不了
 * WCAG 正文的 4.5:1。
 * 因此改成三档**实体色**：亮色 700 / 700 / 600，暗色 300 / 400 / 500
 * （对比度按卡片真实底色实测：亮色 5.32 / 5.32 / 3.62:1，暗色 10.29 / 8.08 / 6.33:1）。
 * 亮色最浅一档低于 AA 正文线且用的正是最小字号，属有意弱化的层级尾部，已在 README 注明。
 * 层级同时由字号与字重承担。
 */
function greenStyle(rank: number, total: number): { shade: 1 | 2 | 3; bold: boolean } {
  if (total <= 1) return { shade: 1, bold: true };
  const t = rank / (total - 1);
  return { shade: rank === 0 ? 1 : t <= 0.5 ? 2 : 3, bold: rank === 0 };
}

/**
 * 非 CJK 字符在估宽里的 em 系数。
 *
 * 取 0.85 而不是 0.55：0.55 只够覆盖「小写拉丁 + 数字 + 空格」的平均字宽，
 * 遇到大写与 `W`/`@` 这类宽字形会严重低估 —— 独立评审用真实字形量过，
 * 15px 的 `W. W. NORTON` 估 99 / 实测 108（右端被裁 2.85px）、
 * `@@@@@@@@` 估 66 / 实测 117（被裁 46px）。
 * 估宽是横向硬约束的判据，低估会直接让字形落到画布外被 overflow:hidden 切掉，
 * 因此宁可高估（排得松一点）也不能低估。emoji 是位图字形，估宽仍可能偏小，
 * 但云图取的是书名作者与出版社，正常数据里不会出现 emoji。
 */
const NON_CJK_EM = 0.85;

/**
 * emoji 按宽字形算。它们是位图字形，字宽通常大于 1em：
 * 实测 15px 的 `📚📖📕📗` 渲染墨迹约 19px/字（≈1.27em），按 0.85em 估会低估约 21px 总宽、
 * 右端被裁。这里按 1.6em 估（宁可高估排松一点）。
 */
const EMOJI_EM = 1.6;
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Emoji_Presentation}/u;

/**
 * 估算词盒宽度（px）。装在浏览器里必然有 Canvas 量文本的能力，但那样只能在客户端量、
 * 首帧会闪；这里按字符类别估：中日韩与全角标点按 1em，其余按 NON_CJK_EM。
 * 汉字与全角标点的估算实测误差为 0（15px 的「尤瓦尔·赫拉利」估 90、实测 88.6）。
 * 导出供测试直接校验。
 */
export function estimateWordWidth(name: string, fontSize: number): number {
  let em = 0;
  for (const ch of name) {
    if (/[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch)) em += 1;
    else if (EMOJI_RE.test(ch)) em += EMOJI_EM;
    else em += NON_CJK_EM;
  }
  return em * fontSize;
}

/**
 * 散开用的是「力导向松弛」而不是螺旋找空位 —— 试过三版螺旋（螺线、环网格、固定椭圆环），
 * 在 166 × 156 这么小的画布上都会退化成中间一竖列或规整的方阵：
 * 因为逐词找「最近的可放点」时，后面的词总能在中心正下方几像素处找到位置。
 * 力导向是反过来做的：先把词按权重撒在一个小圆上，再让它们互相排斥、同时被中心吸引，
 * 迭代若干轮后自然铺成疏密有别的一团 —— 这正是词云该有的样子。
 *
 * 全部是纯函数、固定迭代次数，同一份数据每次结果一致（不闪烁、不会和 SSR 打架）。
 */

/** 词盒之间的最小空隙（排斥的目标距离） */
const MIN_GAP_X = 6;
const MIN_GAP_Y = 4;
/** 迭代轮数：3~5 个词的松弛在 200 轮内已收敛，留到 300 轮是给边界情形的余量 */
const RELAX_ITERS = 300;
/** 初始撒点的角度步长（黄金角），让词一开始就错开 */
const GOLDEN_ANGLE = 2.39996;
/** 排斥强度与向心强度：排斥要够大才铺得开，向心保证不散成一把沙子 */
const REPEL = 0.8;
const CENTER_PULL = 0.0045;
/** 长词降字号的次数上限（每次 1px），避免病态输入下死循环 */
const MAX_FIT_TRIES = 12;
/** 每轮单次位移上限，避免大词把小词一脚踢出画布 */
const MAX_STEP = 4;

interface RawWord {
  name: string;
  note: string;
  weight: number;
}

/**
 * 把词散成一团云：按权重撒点 → 力导向松弛 → 硬分离 → 整团居中。
 *
 * 横向是硬约束：画布外的部分会被卡片的 overflow:hidden 裁掉，
 * 所以先按名次定字号，再把「连画布都装不下」的词压到刚好装下
 * （见下面的降字号循环）—— 否则 clampX 会把 x 夹到左边界，
 * 右半截照样露在画布外被裁掉，或者夹出负宽度造成两个词落在同一点。
 *
 * 导出供测试直接校验：不重叠、不横向出界、整条可见、位置可复现。
 */
export function layoutCloud(
  input: RawWord[],
  width: number,
  height: number,
): CloudPlacement[] {
  const words = input.slice(0, MAX_WORDS_PER_CLOUD);
  const total = words.length;
  if (total === 0) return [];
  const cx = width / 2;
  const cy = height / 2;

  // 词盒：字号按名次，盒子按估宽（横向是硬约束，纵向只有一两行）
  const boxes = words.map((word, rank) => {
    let fontSize = fontPx(rank, total);
    // 装不下的长词逐级降字号：每次降 1px，最多降到 MIN_PX - 2 为止。
    // 现实里极少触发（当前最长词「中信出版集团」6 字 @15px = 90px，画布 126px），
    // 但只要触发就是整段被裁，所以按「宁可小一号也要看得见」处理。
    let tries = 0;
    while (estimateWordWidth(word.name, fontSize) + BOX_PAD_X > width && tries < MAX_FIT_TRIES) {
      fontSize = Math.max(HARD_MIN_PX, fontSize - 1);
      tries++;
    }
    return {
      word,
      rank,
      fontSize,
      // 降到底仍装不下时按画布宽截断盒子：这样 x 至少落在 [EDGE_PAD, EDGE_PAD] 上，
      // 不会夹出负宽度。真实文字仍会长出画布一点，但已是「尽力」的那一档。
      w: Math.min(width - EDGE_PAD * 2, estimateWordWidth(word.name, fontSize) + BOX_PAD_X),
      h: fontSize * 1.25 + BOX_PAD_Y,
      ...greenStyle(rank, total),
    };
  });

  // 初始位置：绕中心的小圆，角度按黄金角错开，避免一开始就对称卡住
  const pos = boxes.map((b, i) => {
    const theta = i * GOLDEN_ANGLE;
    const r = 14 + i * 3;
    return {
      x: cx + Math.cos(theta) * r * 1.6 - b.w / 2,
      y: cy + Math.sin(theta) * r - b.h / 2,
    };
  });

  const clampX = (x: number, w: number) => Math.max(EDGE_PAD, Math.min(width - w - EDGE_PAD, x));

  for (let iter = 0; iter < RELAX_ITERS; iter++) {
    const pushX = new Array<number>(boxes.length).fill(0);
    const pushY = new Array<number>(boxes.length).fill(0);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        // 两个盒子的中心距与「刚好不重叠所需的距离」
        const cix = pos[i].x + boxes[i].w / 2;
        const ciy = pos[i].y + boxes[i].h / 2;
        const cjx = pos[j].x + boxes[j].w / 2;
        const cjy = pos[j].y + boxes[j].h / 2;
        const needX = (boxes[i].w + boxes[j].w) / 2 + MIN_GAP_X;
        const needY = (boxes[i].h + boxes[j].h) / 2 + MIN_GAP_Y;
        const gapX = needX - Math.abs(cix - cjx);
        const gapY = needY - Math.abs(ciy - cjy);
        if (gapX <= 0 || gapY <= 0) continue; // 两个方向都错开了才算不挤
        // 两个轴分别推，方向取两心连线的符号：只沿一条对角线推会让词斜着排队
        const dirX = cix >= cjx ? 1 : -1;
        const dirY = ciy >= cjy ? 1 : -1;
        // 横向推得比纵向猛一些：卡片宽、中文词也宽，横着让位更容易让开
        const fx = REPEL * gapX * 0.55 * dirX;
        const fy = REPEL * gapY * 0.85 * dirY;
        pushX[i] += fx;
        pushY[i] += fy;
        pushX[j] -= fx;
        pushY[j] -= fy;
      }
    }
    for (let i = 0; i < boxes.length; i++) {
      // 向心吸引：不让词飘到画布外，也保证云团围着中心
      pushX[i] += (cx - (pos[i].x + boxes[i].w / 2)) * CENTER_PULL * boxes[i].w;
      pushY[i] += (cy - (pos[i].y + boxes[i].h / 2)) * CENTER_PULL * boxes[i].h * 0.6;
      const step = Math.hypot(pushX[i], pushY[i]);
      const k = step > MAX_STEP ? MAX_STEP / step : 1;
      pos[i].x = clampX(pos[i].x + pushX[i] * k, boxes[i].w);
      pos[i].y = pos[i].y + pushY[i] * k;
    }
  }

  /*
   * 松弛之后再跑一轮「硬分离」兜底：力导向是软约束，收敛后可能还剩几像素交叠
   * （向心吸引与排斥会在某个位置达成平衡）。这里对每一对仍然交叠的盒子，
   * 按「谁更重谁不动」的原则把轻的那个推到不重叠为止 —— 权重高的词守住中心，
   * 这也符合云图的语义：排名低的词给排名高的让位。
   */
  const order = boxes.map((_, i) => i); // rank 升序，重的在前
  for (let pass = 0; pass < 20; pass++) {
    let moved = false;
    for (const i of order) {
      for (const j of order) {
        if (i === j) continue;
        const heavy = boxes[i].rank < boxes[j].rank ? i : j;
        const light = heavy === i ? j : i;
        const hx = pos[heavy].x + boxes[heavy].w / 2;
        const hy = pos[heavy].y + boxes[heavy].h / 2;
        const lx = pos[light].x + boxes[light].w / 2;
        const ly = pos[light].y + boxes[light].h / 2;
        const needX = (boxes[heavy].w + boxes[light].w) / 2 + MIN_GAP_X;
        const needY = (boxes[heavy].h + boxes[light].h) / 2 + MIN_GAP_Y;
        const gapX = needX - Math.abs(hx - lx);
        const gapY = needY - Math.abs(hy - ly);
        if (gapX <= 0 || gapY <= 0) continue;
        const dirX = lx >= hx ? 1 : -1;
        const dirY = ly >= hy ? 1 : -1;
        /*
         * 横向优先（横向空间多、中文词横向让位更容易），但词已被 clampX 夹在
         * 左右边界时横向挪不动，此时必须退到纵向。
         * 早先这里写成 `? "x" : "x"` 的三目，纵向分支永远不可达：
         * 边界上的重叠就此留下，20 轮 pass 全是空推。
         */
        const nextX = clampX(pos[light].x + gapX * dirX, boxes[light].w);
        const canMoveX = Math.abs(nextX - pos[light].x) > 0.01;
        const nextY = pos[light].y + gapY * dirY;
        const canMoveY =
          nextY >= EDGE_PAD && nextY + boxes[light].h <= height - EDGE_PAD;
        if (canMoveX) {
          pos[light].x = nextX;
          moved = true;
        } else if (canMoveY) {
          pos[light].y = nextY;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }

  /*
   * 收尾把整团挪回画布中心：力导向的向心力作用在每个词自己的中心上，
   * 收敛后整团的质心常常偏离画布中心（实测会偏到左上），看起来像没排满。
   * 平移整团不改相对位置，所以不会破坏「不重叠」；平移量再夹一次边界。
   */
  const minX = Math.min(...pos.map((p) => p.x));
  const maxX = Math.max(...pos.map((p, i) => p.x + boxes[i].w));
  const minY = Math.min(...pos.map((p) => p.y));
  const maxY = Math.max(...pos.map((p, i) => p.y + boxes[i].h));
  const shiftX = (width - (maxX - minX)) / 2 - minX;
  const shiftY = (height - (maxY - minY)) / 2 - minY;
  for (let i = 0; i < pos.length; i++) {
    pos[i].x = clampX(pos[i].x + shiftX, boxes[i].w);
    pos[i].y = Math.max(EDGE_PAD, Math.min(height - boxes[i].h - EDGE_PAD, pos[i].y + shiftY));
  }

  return boxes.map((b, i) => ({
    name: b.word.name,
    note: b.word.note,
    x: Math.round(pos[i].x * 10) / 10,
    y: Math.round(pos[i].y * 10) / 10,
    fontSize: b.fontSize,
    shade: b.shade,
    bold: b.bold,
  }));
}

