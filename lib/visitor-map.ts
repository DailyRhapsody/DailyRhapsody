/**
 * 访客地图底图：像素化的世界地图掩码 + 经纬度落格。
 *
 * 数据来源：联合国 Geospatial《世界地图》Map No. 4651 Rev.4（2026-07 版，公开下载）。
 * PDF 是 ArcMap 导出的矢量图，投影为 Eckert IV（把 Natural Earth 陆地按候选投影与该 PDF 的
 * 岸线做配准，Eckert IV 的 IoU 0.89，次优 Robinson/Winkel Tripel 仅 0.70）；按解析反算把官方陆地
 * 重采样到等距圆柱网格，取 188 x 76 格、按格多数表决得出掩码。33 项内陆/开阔水域断点全部通过。
 *
 * 掩码是 LSB-first 位打包的 base64，i = row * W + col，按位序解出来即可；只有 2.6KB，
 * 内嵌进代码，不发请求、不新增图片资源、不碰外部域名。
 *
 * 隐私口径：本模块只做「经纬度 -> 格子」的几何换算；对外发布的点位一律先吸附到格中心
 * （188 x 76 的格子，约 1.9° ≈ 200km 量级），不携带 IP、城市名与精确坐标。
 */

/** 掩码列数（经度方向） */
export const WORLD_MASK_W = 188;
/** 掩码行数（纬度方向） */
export const WORLD_MASK_H = 76;
/** 掩码上边缘纬度 */
export const WORLD_LAT_TOP = 84.0;
/** 掩码下边缘纬度 */
export const WORLD_LAT_BOTTOM = -58.0;

/** 掩码位图（LSB-first base64） */
export const WORLD_MASK_BASE64 =
  "AAAAAACA9P////8BAAAAAAAAAAAAAAAAAAAAAAD4P/z//wcAgAQAAACAAwAAAAAAAAAAIGb9+f//PwAAFQAAAACAAQAAAAAAAABgANAD////BwAAAAAAAAD8AAAAAAAAAAAgQD8A/P8/AAAAAMAAgP8PAAQAAAAAAPyY7Q+A//8BAAAAAAOA///PgQAAAGAAAPxh/gP4/w8AAAAAMPD3///f/w8A4P/33z+N+QD+fwAA4D8AMPv///////8A/v////+fPvA/AAAA/5/+v////////w/w/////3/wAn8ADwB8P/7//////////wD4/////wwe4ANwAODz////////////D/D/////AxwAHgAAwI////////////9/AP75//8/wAcAAAAA/Nn//////////3EAAAP4//8D/AMAAAABDv////////8fwAEAAAD+//+BfwAAADBA/P///////38ADgAAAMD////+DwAAwILw/////////wPgAAAAAPj//+//AQAAZP7//////////wMCAAAAAP////8PAAAA9v//////////PwAAAAAA4P///x8DAADA////////////AgAAAAAA/v///wAAAAD+//////////8HAAAAAADg////PwAAAMDfP/3//////z8AAAAAAAD+//8/AAAAwD/5gf///////zEAAAAAAOD///8BAAAA/GCf8f//////AwAAAAAAAP7//wcAAADAAyT///////8VEAAAAAAAwP//PwAAAAA8IPL//////w+DAAAAAAAA+P//AwAAAID8AOj//////zEOAAAAAAAA//8fAAAAAPwPAP7/////HxgAAAAAAADg//8AAAAA4P8j8P//////QwAAAAAAAAD6fwcAAAAA/v////////8/AAAAAAAAAMD/gAAAAADw////5/////8DAAAAAAAAAPAHCAAAAID////+/P///x8AAAAAAAAAgH4AAAAAAPz//8+f4P///wAAAAAAAAAAwAcAAAAA4P////0f/P//BwAAAAAAAAAAeAgCAAAA/v//3/+Bf/wLAAAAAAAAAACAzwABAADg////+Q/wg58AAAAAAAAAAADgDwAAAAD+//8/fwAf+AMCAAAAAAAAAADgAwAAAOD////3AfAAfgAAAAAAAAAAAAA4AAAAAP7///8HAA7gBwAAAAAAAAAAAAADAAAAwP///w8A4AByAAAAAAAAAAAAACD8AQAA/P///w8ABAADAAAAAAAAAAAAAOh/AACA/////wCAAALAAAAAAAAAAAAAAP4PAADw8///BwAAQAAAAAAAAAAAAAAA4P8HAAAA/P9/AAAADQYAAAAAAAAAAAAA/n8AAACA//8DAACgcAAAAAAAAAAAAADw/wcAAAD4/w8AAACMBwAAAAAAAAAAAID//wMAAMD//wAAAMB4gQAAAAAAAAAAAPD//wEAAPj/BwAAABgz+AAAAAAAAAAAgP//fwAAAP8/AAAAAAEAPgAAAAAAAAAA8P//DwAA8P8DAAAA4ADABwAAAAAAAAAA//9/AAAA/j8AAAAAAABYAAAAAAAAAADg//8HAADg/wcAAAAAAAAAAAAAAAAAAAD8/z8AAAD+fwAAAAAAwBEAAAAAAAAAAMD//wEAAPD/hwAAAAAAHgEAAAAAAAAAAPj/HwAAAP9/DgAAAAD4MwAAAAAAAAAAAP7/AQAA8P/hAAAAAMD/AwAAAAAAAAAA4P8fAAAA/g8GAAAAAP5/AAAAAAAAAAAA/v8AAADg/2AAAAAA/P8PAAAAAAAAAADg/wMAAAD+DwYAAADg//8BAAAAAAAAAAD+HwAAAMB/IAAAAAD+/z8AAAAAAAAAAOD/AQAAAPwHAAAAAMD//wMAAAAAAAAAAP4PAAAAgH8AAAAAAPz/PwAAAAAAAAAA4H8AAAAA+AMAAAAAwP//AwAAAAAAAAAA/gMAAAAAHwAAAAAAfPAfAAAAAAAAAADwHwAAAAAAAAAAAACAAPwBAAAAAAAAAAD/AAAAAAAAAAAAAAAAgB8AAAAAAAAAAPAPAAAAAAAAAAAAAAAAAABgAAAAAAAAAD8AAAAAAAAAAAAAAAAAAAAEAAAAAAAA8AEAAAAAAAAAAAAAAADAABAAAAAAAAAADwAAAAAAAAAAAAAAAAAAwAAAAAAAAABwAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAPAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

/** 解出 1 = 陆地、0 = 海洋 的位图（服务端与浏览器共用，所以走 atob，不用 Buffer）。 */
export function decodeWorldMask(): Uint8Array {
  const bin = atob(WORLD_MASK_BASE64);
  const out = new Uint8Array(WORLD_MASK_W * WORLD_MASK_H);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = (bin.charCodeAt(i >> 3) >> (i & 7)) & 1;
  }
  return out;
}

export type WorldCell = { col: number; row: number };

/** 经纬度 -> 格子。经度按 ±180 是同一根子午线回绕，纬度越界夹到边缘格；都不抛错。 */
export function worldCellFor(lat: number, lon: number): WorldCell {
  const wrapped = (((lon + 180) % 360) + 360) % 360 - 180;
  const col = Math.floor(((wrapped + 180) / 360) * WORLD_MASK_W);
  const row = Math.floor(((WORLD_LAT_TOP - lat) / (WORLD_LAT_TOP - WORLD_LAT_BOTTOM)) * WORLD_MASK_H);
  return {
    col: Math.min(Math.max(col, 0), WORLD_MASK_W - 1),
    row: Math.min(Math.max(row, 0), WORLD_MASK_H - 1),
  };
}

/**
 * 格子中心点的经纬度（对外发布点位时用它替代精确坐标）。
 * 收敛到 3 位小数：格子本身约 1.9°，多出来的浮点位没有信息量，只会让「格子中心」看起来像精确坐标。
 */
export function worldCellCenter(cell: WorldCell): { lat: number; lon: number } {
  const lon = -180 + ((cell.col + 0.5) / WORLD_MASK_W) * 360;
  const lat =
    WORLD_LAT_TOP - ((cell.row + 0.5) / WORLD_MASK_H) * (WORLD_LAT_TOP - WORLD_LAT_BOTTOM);
  return { lat: Math.round(lat * 1000) / 1000, lon: Math.round(lon * 1000) / 1000 };
}

/**
 * 发布点位的运行时校验：缓存读回来的值同样要过关（同一 Redis 库里还存着 Notion 缓存、
 * 限流计数与 profile，不能假设 dr:visitormap:* 里的东西一定是本函数写进去的）。
 */
export function isValidVisitorMapPoint(p: unknown): p is VisitorMapPoint {
  const v = p as VisitorMapPoint | null;
  if (!v || typeof v !== "object") return false;
  if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon) || !Number.isFinite(v.count)) return false;
  if (v.lat < WORLD_LAT_BOTTOM || v.lat > WORLD_LAT_TOP) return false;
  if (v.lon < -180 || v.lon > 180) return false;
  if (v.count <= 0 || !Number.isInteger(v.count)) return false;
  const cell = worldCellFor(v.lat, v.lon);
  const center = worldCellCenter(cell);
  return Math.abs(center.lat - v.lat) < 1e-6 && Math.abs(center.lon - v.lon) < 1e-6;
}

export type VisitorMapSourcePoint = { lat: number; lng: number; count: number };
/** 对外发布的点位：已吸附到格中心，只有格子粒度。 */
export type VisitorMapPoint = { lat: number; lon: number; count: number };

/** 单次最多发布的格子数：超过就只保留访问次数最高的那些 */
export const VISITOR_MAP_MAX_CELLS = 400;

/**
 * 把原始访问点（含精确经纬度）聚合成格子级的发布点位：
 * 同格合并计数 -> 坐标替换为格中心 -> 按次数降序 -> 截断到上限。
 * 这是发布前唯一的聚合入口，精确坐标不会离开这个函数。
 */
export function aggregateVisitorPoints(
  points: VisitorMapSourcePoint[],
  maxCells = VISITOR_MAP_MAX_CELLS,
): VisitorMapPoint[] {
  const byCell = new Map<string, VisitorMapPoint>();
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || !Number.isFinite(p.count) || p.count <= 0) {
      continue;
    }
    const cell = worldCellFor(p.lat, p.lng);
    const key = `${cell.row}:${cell.col}`;
    const existing = byCell.get(key);
    if (existing) existing.count += p.count;
    else byCell.set(key, { ...worldCellCenter(cell), count: p.count });
  }
  return [...byCell.values()].sort((a, b) => b.count - a.count).slice(0, maxCells);
}
