/**
 * 右下角的像素宇航员，照作者本人画：透明面罩里是短寸头、圆框玳瑁眼镜，
 * 灰色卫衣质感的宇航服、黑色背包肩带，红臂章取自站点头像。
 * 待机时失重漂浮、镜片后的眼睛眨动；生成回复时眼睛闪烁。
 * 动画都在 globals.css 的 dr-pet-* 里，prefers-reduced-motion 下全部关闭。
 */

const ASTRONAUT = [
  "......KKKKKKKKKK......",
  "....KKGGGGGGGGGGKK....",
  "...KGGGhHHhHHHhGLGK...",
  "..KGGHHHhHHHhHHHHLGK..",
  "..KGGHhHHHhHHHhHHGLK..",
  "..KGGHSSSSSSSSSSHGGK..",
  "..KGGSTtTSSSSTtTSGGK..",
  "..KGGTSESTccTSESTGGK..",
  "..KGGtSSSTSStSSSTGGK..",
  "..KGGStTtSSSStTtSGGK..",
  "..KGGSSSSSSsSSSSSGGK..",
  "...KGGSSSmMMmSSSGGK...",
  "....KKGsSSSSSSsGKK....",
  "......KCCCCCCCCK......",
  "...KWWWBWWWWWWBWWWK...",
  "..KKWWWBWWWWWWBWWDKK..",
  ".KWKWWWBWWWWWWBWWDKWK.",
  ".KRKWWWBWWWWWWBWWDKDK.",
  ".KWKWWWWWWWWWWWWWDKDK.",
  "..KKWWWWWWWWWWWWWDKK..",
  "...KWWWWWKKWWWWWDK....",
  "...KWWWWK..KWWWWDK....",
  "...KKKKKK..KKKKKKK....",
];

const PALETTE: Record<string, string> = {
  K: "#27272a", // 描边
  G: "#dbeafe", // 面罩玻璃
  L: "#ffffff", // 玻璃高光
  H: "#1c1917", // 头发
  h: "#3f3a36",
  S: "#f2c6a5", // 皮肤
  s: "#d9a582",
  T: "#8a5a33", // 玳瑁镜框
  t: "#5e3b20",
  c: "#b8b8bd", // 银色鼻梁
  E: "#1f2937", // 眼睛
  M: "#c0705f",
  m: "#dea08a",
  C: "#b4b4b9", // 领口罗纹
  W: "#d9d9dc", // 灰色卫衣质感的宇航服
  D: "#a9a9af",
  B: "#1f1f22", // 背包肩带
  R: "#ef4444", // 红臂章
};

type Run = { x: number; y: number; w: number; c: string };

/** 同色相邻像素合并成一条 rect，22×23 的图只需一百来个节点 */
function toRuns(sprite: string[]): Run[] {
  const runs: Run[] = [];
  sprite.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const c = row[x];
      if (c === ".") {
        x++;
        continue;
      }
      let w = 1;
      while (row[x + w] === c) w++;
      runs.push({ x, y, w, c });
      x += w;
    }
  });
  return runs;
}


/** 5×7 像素字：AI 直接画在头部左上角，跟随 dr-pet-float 一起浮动 */
const AI_GLYPHS: Record<string, string[]> = {
  A: ["00100", "01010", "10001", "10001", "11111", "10001", "10001"],
  I: ["111", "010", "010", "010", "010", "010", "111"],
};

const AI_RUNS = (() => {
  const runs: { x: number; y: number; w: number }[] = [];
  let cursor = -8;
  for (const ch of "AI") {
    const rows = AI_GLYPHS[ch];
    rows.forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        if (row[x] !== "1") {
          x++;
          continue;
        }
        let w = 1;
        while (row[x + w] === "1") w++;
        runs.push({ x: cursor + x, y: 1 + y, w });
        x += w;
      }
    });
    cursor += rows[0].length + 1;
  }
  return runs;
})();

const BODY_RUNS = toRuns(ASTRONAUT).filter((r) => r.c !== "E");
const EYE_RUNS = toRuns(ASTRONAUT).filter((r) => r.c === "E");

function Rects({ runs }: { runs: Run[] }) {
  return (
    <>
      {runs.map((r) => (
        <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill={PALETTE[r.c]} />
      ))}
    </>
  );
}

export function PixelAstronaut({
  scale = 3,
  thinking = false,
  still = false,
  ai = false,
}: {
  /** 每个像素的屏幕尺寸（px） */
  scale?: number;
  thinking?: boolean;
  /** 面板头像等小尺寸处不漂浮 */
  still?: boolean;
  /** 在头部左上角画像素字 AI；只给右下角入口使用 */
  ai?: boolean;
}) {
  const w = ASTRONAUT[0].length;
  const h = ASTRONAUT.length;
  return (
    <span className="relative inline-block" style={{ width: w * scale, height: h * scale }} aria-hidden="true">
      <svg
        className={`absolute inset-0 overflow-visible ${still ? "" : "dr-pet-float"}`}
        width={w * scale}
        height={h * scale}
        viewBox={`0 0 ${w} ${h}`}
        shapeRendering="crispEdges"
      >
        <Rects runs={BODY_RUNS} />
        {ai && (
          <g className="dr-pet-ai" transform="translate(-3 -3) scale(0.65)">
            <g fill="#18181b">
              {AI_RUNS.map((r) => <rect key={`ai-o-${r.x}-${r.y}`} x={r.x - .3} y={r.y - .3} width={r.w + .6} height={1.6} />)}
            </g>
            <g fill="#f8d488">
              {AI_RUNS.map((r) => <rect key={`ai-f-${r.x}-${r.y}`} x={r.x} y={r.y} width={r.w} height={1} />)}
            </g>
          </g>
        )}
        <g className={thinking ? "dr-pet-eyes-think" : "dr-pet-eyes"}>
          <Rects runs={EYE_RUNS} />
        </g>
      </svg>
    </span>
  );
}
