/**
 * 右下角的像素宇航员，照作者本人画：透明面罩里是短寸头、圆框玳瑁眼镜，
 * 灰色卫衣质感的宇航服、黑色背包肩带，红臂章与纸飞机取自站点头像。
 * 待机时失重漂浮、镜片后的眼睛眨动；生成回复时眼睛闪烁、纸飞机绕飞。
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

const PLANE = [
  "........KK",
  ".....KKKPK",
  "..KKKPPPK.",
  "KKPPPPPK..",
  ".KKQQPK...",
  "...KKQK...",
  ".....KK...",
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
  P: "#ffffff", // 纸飞机
  Q: "#e4e4e7",
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

const BODY_RUNS = toRuns(ASTRONAUT).filter((r) => r.c !== "E");
const EYE_RUNS = toRuns(ASTRONAUT).filter((r) => r.c === "E");
const PLANE_RUNS = toRuns(PLANE);

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
}: {
  /** 每个像素的屏幕尺寸（px） */
  scale?: number;
  thinking?: boolean;
  /** 面板头像等小尺寸处不漂浮 */
  still?: boolean;
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
        <g className={thinking ? "dr-pet-eyes-think" : "dr-pet-eyes"}>
          <Rects runs={EYE_RUNS} />
        </g>
      </svg>
      {thinking && !still && (
        <span className="dr-pet-plane pointer-events-none absolute left-1/2 top-1/2">
          <svg
            width={PLANE[0].length * Math.max(1, scale - 1)}
            height={PLANE.length * Math.max(1, scale - 1)}
            viewBox={`0 0 ${PLANE[0].length} ${PLANE.length}`}
            shapeRendering="crispEdges"
            className="-translate-x-1/2 -translate-y-1/2"
          >
            <Rects runs={PLANE_RUNS} />
          </svg>
        </span>
      )}
    </span>
  );
}
