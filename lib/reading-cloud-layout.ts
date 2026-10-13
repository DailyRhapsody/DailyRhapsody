/**
 * 云图屏的排布算法（纯函数，无 React 依赖，便于单测）。
 *
 * 见 components/entries/ReadingCloudScreen.tsx 的组件说明：这是把一屏词
 * 散成一团云的那部分，做得可测是因为它踩过太多坑 ——
 * 螺旋找空位、环网格、固定椭圆环三版在这块小画布上都会退化成竖列或方阵，
 * 最终改成「力导向松弛 + 硬分离 + 整团居中」。
 */

/** 字号区间：每屏 3~4 个词，首名 15px、末名 11px */
const MIN_PX = 11;
const MAX_PX = 15;
/**
 * 碰撞盒的额外留白：估宽有 ±2px 误差，字间再留一点视觉间隙。
 * 水平方向是硬约束（越界会被裁掉），所以宽留 4px；垂直方向正文只有一两行，
 * 留太多会把可用区占满、后面的词无处可去，因此只留 2px。
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
  alpha: number;
  bold: boolean;
};

/** 名次 → 字号：首名 MAX_PX，末名 MIN_PX，线性递减 */
function fontPx(rank: number, total: number): number {
  if (total <= 1) return MAX_PX;
  return Math.round(MAX_PX - (MAX_PX - MIN_PX) * (rank / (total - 1)));
}

/**
 * 名次 → 绿色深浅。全部是主题绿，只是越靠后越淡（90% → 60%），
 * 首名再加粗。不用灰阶，也不引入第二种色相。
 */
function greenStyle(rank: number, total: number): { alpha: number; bold: boolean } {
  if (total <= 1) return { alpha: 1, bold: true };
  const t = rank / (total - 1);
  return { alpha: Math.round((0.62 + 0.38 * (1 - t)) * 100) / 100, bold: rank === 0 };
}

/**
 * 估算词盒宽度（px）。装在浏览器里必然有 Canvas 量文本的能力，但那样只能在客户端量、
 * 首帧会闪；这里按字符类别估：中日韩与全角标点按 1em，其余（拉丁字母、数字、空格）按 0.55em。
 * 实测 15px 的「尤瓦尔·赫拉利」估 90px、实际 88.6px，误差在 2px 内，够用来排不重叠。
 */
export function estimateWordWidth(name: string, fontSize: number): number {
  let em = 0;
  for (const ch of name) {
    em += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch) ? 1 : 0.55;
  }
  return em * fontSize;
}

/**
 * 圆形散开的落位：首名居中，其余按角度均匀分布在一圈（必要时套第二圈）上。
 *
 * 为什么不用「螺旋找第一个空位」那套通用算法（试过三版，都退化）：
 * 卡片只有 156px 宽，出版社一个词就占 90~110px，通用算法逐词找最近空位时，
 * 后续词总能在中心正下方几像素处找到一个「不压住」的点，
 * 于是六个词排成一竖列 —— 看起来像列表，不像云图。
 * 改成显式的环：第 k 个词的角度 = 均分角 + 黄金角 × k，半径按圈数递推，
 * 落不下（横向会越界、或撞上已放的词）就换下一个角度，最多试一圈半。
 * 结果稳定：同一份数据每次都一样，且词必然绕着中心铺开。
 *
 * 椭圆而不是正圆：卡片是 166 宽 × 156 高的横向矩形，正圆会把词推到左右边界外。
 */
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
/** 迭代轮数：5 个词时 40 轮足够收敛，再多只是浪费渲染时间 */
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
 * （见 MAX_FIT_TRIES 那段）—— 否则 clampX 会把 x 夹到左边界，
 * 右半截照样露在画布外被裁掉，或者夹出负宽度造成两个词落在同一点。
 *
 * 导出供测试直接校验：不重叠、不横向出界、整条可见、位置可复现。
 */
export function layoutCloud(words: RawWord[], width: number, height: number): CloudPlacement[] {
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
      fontSize = Math.max(MIN_PX - 2, fontSize - 1);
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
  const order = boxes.map((b, i) => i).sort((a, b) => a - b); // rank 升序，重的在前
  for (let pass = 0; pass < 12; pass++) {
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
        // 优先往横向躲：横向空间多，且中文词横向让位更容易
        const dirX = lx >= hx ? 1 : -1;
        const dirY = ly >= hy ? 1 : -1;
        const useX = gapX * 0.55 <= gapY ? "x" : "x";
        if (useX === "x") {
          pos[light].x = clampX(pos[light].x + gapX * dirX, boxes[light].w);
        } else {
          pos[light].y += gapY * dirY;
        }
        moved = true;
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
    alpha: b.alpha,
    bold: b.bold,
  }));
}

