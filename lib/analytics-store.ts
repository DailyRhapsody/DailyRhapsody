import { Redis } from "@upstash/redis";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  USE_DATABASE,
  assertWritableStorage,
  ensureSchemaOnce,
  getPool,
} from "./db";

const DATA_DIR = join(process.cwd(), "data");
const JSONL_FILE = join(DATA_DIR, "analytics-visits.jsonl");

const ANALYTICS_STORAGE_ERROR =
  "DATABASE_URL is required in production for visitor analytics (file mode is not supported on serverless).";

/**
 * 有 KV 凭证时访问记录存 Upstash Redis（与 profile、限流同库同凭证）。
 * 生产的 DATABASE_URL 指向的 Supabase 项目已删除（2026-09 域名 NXDOMAIN），每次写入都报
 * tenant/user not found、被 collect 路由静默吞掉，统计从那时起一条都没记下来。
 * 按 UTC 日期分键存原始记录，查询时逐日读出、在内存里聚合（与本地 JSONL 同一套逻辑）。
 * 没有 KV 凭证的环境照旧走 Postgres / 本地文件。
 */
const redisUrl = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
const redis = redisUrl && redisToken ? new Redis({ url: redisUrl, token: redisToken }) : null;

const VISITS_KEY_PREFIX = "dr:analytics:visits:";
// 这个 Upstash 同时存着 Notion 缓存、限流计数和 profile，容量按最坏情况控制：保留 30 天；
// 每天最多 1000 条、按 UA 识别的疑似爬虫另存最多 200 条（超出丢当天最早的；爬虫不占这 1000 条，
// 伪装浏览器 UA 的刷量仍会挤掉当天较早的记录）；单条记录不超过 2KB（boundRow），
// 最坏约 1200 × 2KB × 30 ≈ 72MB，日常访问量远低于此。
const RETENTION_DAYS = 30;
const MAX_HUMAN_VISITS_PER_DAY = 1000;
const MAX_BOT_VISITS_PER_DAY = 200;
const MAX_ROW_BYTES = 2048;
const DAY_MS = 86_400_000;

// 控制字符与孤立代理项在 JSON 里会被转义成 6 字节，截短前先去掉，避免单条记录被撑大
const UNSAFE_CHARS = /[\u0000-\u001f\u007f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

function clipField(s: string | null, max: number): string | null {
  if (s == null) return null;
  let t = s.replace(UNSAFE_CHARS, "").slice(0, max);
  // 截在 emoji 等代理对中间时，丢掉残留的半个字符
  const last = t.charCodeAt(t.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) t = t.slice(0, -1);
  return t || null;
}

async function ensureSchema(): Promise<void> {
  await ensureSchemaOnce("visit_events", async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS visit_events (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ip TEXT,
        country TEXT,
        region TEXT,
        city TEXT,
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        path TEXT NOT NULL,
        query_string TEXT,
        referrer TEXT,
        user_agent TEXT,
        accept_language TEXT,
        utm_source TEXT,
        utm_medium TEXT,
        utm_campaign TEXT,
        visitor_id TEXT,
        is_bot BOOLEAN NOT NULL DEFAULT FALSE,
        screen_width INT,
        screen_height INT
      );
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS visit_events_created_at_idx ON visit_events (created_at DESC);`
    );
    await client.query(`CREATE INDEX IF NOT EXISTS visit_events_path_idx ON visit_events (path);`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS visit_events_country_idx ON visit_events (country);`
    );
    await client.query(`CREATE INDEX IF NOT EXISTS visit_events_ip_idx ON visit_events (ip);`);
  });
}

export type VisitInput = {
  ip: string;
  country: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  path: string;
  queryString: string | null;
  referrer: string | null;
  userAgent: string | null;
  acceptLanguage: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  visitorId: string | null;
  isBot: boolean;
  screenWidth: number | null;
  screenHeight: number | null;
};

export type VisitRow = {
  id: string;
  createdAt: string;
  ip: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  path: string;
  queryString: string | null;
  referrer: string | null;
  userAgent: string | null;
  acceptLanguage: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  visitorId: string | null;
  isBot: boolean;
  screenWidth: number | null;
  screenHeight: number | null;
};

function newJsonlId(): string {
  return `${Date.now()}-${randomBytes(6).toString("hex")}`;
}

function mapPgRow(row: Record<string, unknown>): VisitRow {
  const id = row.id != null ? String(row.id) : "";
  const createdAt =
    row.created_at instanceof Date
      ? row.created_at.toISOString()
      : String(row.created_at ?? "");
  return {
    id,
    createdAt,
    ip: row.ip != null ? String(row.ip) : null,
    country: row.country != null ? String(row.country) : null,
    region: row.region != null ? String(row.region) : null,
    city: row.city != null ? String(row.city) : null,
    latitude: row.latitude != null ? Number(row.latitude) : null,
    longitude: row.longitude != null ? Number(row.longitude) : null,
    path: String(row.path ?? ""),
    queryString: row.query_string != null ? String(row.query_string) : null,
    referrer: row.referrer != null ? String(row.referrer) : null,
    userAgent: row.user_agent != null ? String(row.user_agent) : null,
    acceptLanguage: row.accept_language != null ? String(row.accept_language) : null,
    utmSource: row.utm_source != null ? String(row.utm_source) : null,
    utmMedium: row.utm_medium != null ? String(row.utm_medium) : null,
    utmCampaign: row.utm_campaign != null ? String(row.utm_campaign) : null,
    visitorId: row.visitor_id != null ? String(row.visitor_id) : null,
    isBot: Boolean(row.is_bot),
    screenWidth: row.screen_width != null ? Number(row.screen_width) : null,
    screenHeight: row.screen_height != null ? Number(row.screen_height) : null,
  };
}

function toVisitRow(input: VisitInput): VisitRow {
  return {
    id: newJsonlId(),
    createdAt: new Date().toISOString(),
    ip: input.ip === "unknown" ? null : input.ip,
    country: input.country,
    region: input.region,
    city: input.city,
    latitude: input.latitude,
    longitude: input.longitude,
    path: input.path,
    queryString: input.queryString,
    referrer: input.referrer,
    userAgent: input.userAgent,
    acceptLanguage: input.acceptLanguage,
    utmSource: input.utmSource,
    utmMedium: input.utmMedium,
    utmCampaign: input.utmCampaign,
    visitorId: input.visitorId,
    isBot: input.isBot,
    screenWidth: input.screenWidth,
    screenHeight: input.screenHeight,
  };
}

/**
 * 存进共享 Redis 前再截短一轮：collect 路由的上限是为 Postgres 定的，单条可达约 6KB。
 * 字段按字符截短，中文等多字节字符仍可能超出字节预算，超出时依次丢弃次要字段，最后再截短路径。
 */
function boundRow(row: VisitRow): VisitRow {
  const out = clipRow(row);
  const fits = () => Buffer.byteLength(JSON.stringify(out), "utf8") <= MAX_ROW_BYTES;
  for (const field of ["referrer", "queryString", "userAgent", "utmCampaign", "utmMedium", "utmSource", "acceptLanguage"] as const) {
    if (fits()) return out;
    out[field] = null;
  }
  if (!fits()) out.path = clipField(out.path, 64) ?? "/";
  return out;
}

function clipRow(row: VisitRow): VisitRow {
  return {
    ...row,
    ip: clipField(row.ip, 64),
    country: clipField(row.country, 64),
    region: clipField(row.region, 64),
    city: clipField(row.city, 64),
    path: clipField(row.path, 256) ?? "/",
    queryString: clipField(row.queryString, 256),
    referrer: clipField(row.referrer, 512),
    userAgent: clipField(row.userAgent, 256),
    acceptLanguage: clipField(row.acceptLanguage, 64),
    utmSource: clipField(row.utmSource, 64),
    utmMedium: clipField(row.utmMedium, 64),
    utmCampaign: clipField(row.utmCampaign, 64),
    visitorId: clipField(row.visitorId, 64),
  };
}

function visitsKey(day: string, bot: boolean): string {
  return `${VISITS_KEY_PREFIX}${day}${bot ? ":bot" : ""}`;
}

export async function recordVisit(input: VisitInput): Promise<void> {
  if (redis) {
    const row = boundRow(toVisitRow(input));
    const key = visitsKey(row.createdAt.slice(0, 10), row.isBot);
    const p = redis.pipeline();
    p.rpush(key, row);
    p.ltrim(key, -(row.isBot ? MAX_BOT_VISITS_PER_DAY : MAX_HUMAN_VISITS_PER_DAY), -1);
    p.expire(key, RETENTION_DAYS * 24 * 60 * 60);
    await p.exec();
    return;
  }

  assertWritableStorage(ANALYTICS_STORAGE_ERROR);
  if (USE_DATABASE) {
    await ensureSchema();
    await getPool().query(
      `
        INSERT INTO visit_events (
          ip, country, region, city, latitude, longitude,
          path, query_string, referrer, user_agent, accept_language,
          utm_source, utm_medium, utm_campaign, visitor_id, is_bot,
          screen_width, screen_height
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
        )
      `,
      [
        input.ip === "unknown" ? null : input.ip,
        input.country,
        input.region,
        input.city,
        input.latitude,
        input.longitude,
        input.path,
        input.queryString,
        input.referrer,
        input.userAgent,
        input.acceptLanguage,
        input.utmSource,
        input.utmMedium,
        input.utmCampaign,
        input.visitorId,
        input.isBot,
        input.screenWidth,
        input.screenHeight,
      ]
    );
    return;
  }

  await mkdir(DATA_DIR, { recursive: true });
  await appendFile(JSONL_FILE, `${JSON.stringify(toVisitRow(input))}\n`, "utf8");
}

export type AnalyticsQuery = {
  from: Date;
  to: Date;
  includeBots: boolean;
  page: number;
  pageSize: number;
};

export type AnalyticsSummary = {
  total: number;
  humanTotal: number;
  botTotal: number;
  uniqueIp: number;
  uniqueVisitors: number;
};

export type TopItem = { key: string; count: number };
export type DailyItem = { date: string; count: number };
export type GeoPoint = { lat: number; lng: number; count: number; city: string | null; country: string | null };

export type AnalyticsReport = {
  summary: AnalyticsSummary;
  topPaths: TopItem[];
  topCountries: TopItem[];
  topRegions: TopItem[];
  daily: DailyItem[];
  geoPoints: GeoPoint[];
  rows: VisitRow[];
  totalRows: number;
};

function parseJsonlLine(line: string): VisitRow | null {
  const t = line.trim();
  if (!t) return null;
  try {
    const o = JSON.parse(t) as VisitRow;
    if (!o || typeof o.path !== "string" || !o.createdAt) return null;
    return o;
  } catch {
    return null;
  }
}

function isVisitRow(o: unknown): o is VisitRow {
  const v = o as VisitRow | null;
  return (
    !!v &&
    typeof v === "object" &&
    typeof v.path === "string" &&
    Number.isFinite(new Date(v.createdAt).getTime())
  );
}

/**
 * 逐日读取，每天真人、爬虫两个键并发各发一个请求（@upstash/redis 不对 LRANGE 做自动管道），
 * 不一次读整段区间，避免单次返回过大。起止都钳到「保留期内且不晚于今天」，过期或未来的日期键不存在，
 * 不必逐个去读。
 */
async function loadRedisVisits(client: Redis, from: Date, to: Date): Promise<VisitRow[]> {
  const start = Math.max(from.getTime(), Date.now() - (RETENTION_DAYS + 1) * DAY_MS);
  const end = Math.min(to.getTime(), Date.now());
  const rows: VisitRow[] = [];
  for (let day = Math.floor(start / DAY_MS) * DAY_MS; day <= end; day += DAY_MS) {
    const date = new Date(day).toISOString().slice(0, 10);
    const [humans, bots] = await Promise.all([
      client.lrange<VisitRow>(visitsKey(date, false), 0, -1),
      client.lrange<VisitRow>(visitsKey(date, true), 0, -1),
    ]);
    for (const v of [...humans, ...bots]) {
      if (!isVisitRow(v)) continue;
      const ts = new Date(v.createdAt).getTime();
      if (ts < from.getTime() || ts > to.getTime()) continue;
      rows.push(v);
    }
  }
  rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return rows;
}

async function loadJsonlVisits(from: Date, to: Date, includeBots: boolean): Promise<VisitRow[]> {
  let raw = "";
  try {
    raw = await readFile(JSONL_FILE, "utf8");
  } catch {
    return [];
  }
  const rows: VisitRow[] = [];
  for (const line of raw.split("\n")) {
    const v = parseJsonlLine(line);
    if (!v) continue;
    const ts = new Date(v.createdAt).getTime();
    if (ts < from.getTime() || ts > to.getTime()) continue;
    if (!includeBots && v.isBot) continue;
    rows.push(v);
  }
  rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return rows;
}

function countUnique(values: (string | null | undefined)[]): number {
  return new Set(values.filter((x): x is string => !!x && x.length > 0)).size;
}

function aggregateFromRows(all: VisitRow[], includeBots: boolean): Omit<AnalyticsReport, "rows" | "totalRows"> {
  const filtered = includeBots ? all : all.filter((r) => !r.isBot);
  const botTotal = all.filter((r) => r.isBot).length;
  const humanTotal = all.length - botTotal;

  const topMap = (keyFn: (r: VisitRow) => string) => {
    const m = new Map<string, number>();
    for (const r of filtered) {
      const k = keyFn(r);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count);
  };

  const dailyMap = new Map<string, number>();
  for (const r of filtered) {
    const d = new Date(r.createdAt).toISOString().slice(0, 10);
    dailyMap.set(d, (dailyMap.get(d) ?? 0) + 1);
  }
  const daily: DailyItem[] = [...dailyMap.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // 地理聚合
  const geoMap = new Map<string, GeoPoint>();
  for (const r of filtered) {
    if (r.latitude == null || r.longitude == null) continue;
    const key = `${r.latitude.toFixed(2)},${r.longitude.toFixed(2)}`;
    const existing = geoMap.get(key);
    if (existing) {
      existing.count++;
    } else {
      geoMap.set(key, { lat: r.latitude, lng: r.longitude, count: 1, city: r.city, country: r.country });
    }
  }
  const geoPoints = [...geoMap.values()].sort((a, b) => b.count - a.count).slice(0, 500);

  return {
    summary: {
      total: all.length,
      humanTotal,
      botTotal,
      uniqueIp: countUnique(filtered.map((r) => r.ip ?? undefined)),
      uniqueVisitors: countUnique(filtered.map((r) => r.visitorId ?? undefined)),
    },
    topPaths: topMap((r) => r.path).slice(0, 25),
    topCountries: topMap((r) => r.country || "(未知)").slice(0, 25),
    topRegions: topMap((r) => [r.country, r.region].filter(Boolean).join(" / ") || "(未知)").slice(
      0,
      25
    ),
    daily,
    geoPoints,
  };
}

/** 内存聚合 + 分页：Redis 与本地 JSONL 两种存储共用。 */
function reportFromRows(all: VisitRow[], q: AnalyticsQuery): AnalyticsReport {
  const offset = (q.page - 1) * q.pageSize;
  const agg = aggregateFromRows(all, q.includeBots);
  const filteredRows = q.includeBots ? all : all.filter((r) => !r.isBot);
  const totalRows = filteredRows.length;
  const rows = filteredRows.slice(offset, offset + q.pageSize);
  return {
    ...agg,
    summary: q.includeBots
      ? agg.summary
      : {
          ...agg.summary,
          uniqueIp: countUnique(filteredRows.map((r) => r.ip ?? undefined)),
          uniqueVisitors: countUnique(filteredRows.map((r) => r.visitorId ?? undefined)),
        },
    rows,
    totalRows,
  };
}

export async function queryAnalytics(q: AnalyticsQuery): Promise<AnalyticsReport> {
  if (redis) return reportFromRows(await loadRedisVisits(redis, q.from, q.to), q);

  assertWritableStorage(ANALYTICS_STORAGE_ERROR);
  const offset = (q.page - 1) * q.pageSize;

  if (USE_DATABASE) {
    await ensureSchema();
    const pool = getPool();
    const botClause = q.includeBots ? "" : " AND is_bot = FALSE";

    const sumRes = await pool.query(
      `
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE NOT is_bot)::int AS human_total,
          COUNT(*) FILTER (WHERE is_bot)::int AS bot_total,
          COUNT(DISTINCT ip) FILTER (WHERE ip IS NOT NULL AND ip <> '')::int AS unique_ip,
          COUNT(DISTINCT visitor_id) FILTER (WHERE visitor_id IS NOT NULL AND visitor_id <> '')::int AS unique_visitors
        FROM visit_events
        WHERE created_at >= $1 AND created_at <= $2
      `,
      [q.from, q.to]
    );
    const srow = sumRes.rows[0] as Record<string, unknown>;
    const summary: AnalyticsSummary = {
      total: Number(srow.total) || 0,
      humanTotal: Number(srow.human_total) || 0,
      botTotal: Number(srow.bot_total) || 0,
      uniqueIp: Number(srow.unique_ip) || 0,
      uniqueVisitors: Number(srow.unique_visitors) || 0,
    };

    if (!q.includeBots) {
      summary.uniqueIp = Number(
        (
          await pool.query(
            `SELECT COUNT(DISTINCT ip)::int AS c FROM visit_events
             WHERE created_at >= $1 AND created_at <= $2 AND is_bot = FALSE
             AND ip IS NOT NULL AND ip <> ''`,
            [q.from, q.to]
          )
        ).rows[0]?.c ?? 0
      );
      summary.uniqueVisitors = Number(
        (
          await pool.query(
            `SELECT COUNT(DISTINCT visitor_id)::int AS c FROM visit_events
             WHERE created_at >= $1 AND created_at <= $2 AND is_bot = FALSE
             AND visitor_id IS NOT NULL AND visitor_id <> ''`,
            [q.from, q.to]
          )
        ).rows[0]?.c ?? 0
      );
    }

    const topPathsRes = await pool.query(
      `SELECT path AS key, COUNT(*)::int AS count FROM visit_events
       WHERE created_at >= $1 AND created_at <= $2 ${botClause}
       GROUP BY path ORDER BY count DESC LIMIT 25`,
      [q.from, q.to]
    );
    const topCountriesRes = await pool.query(
      `SELECT COALESCE(country, '(未知)') AS key, COUNT(*)::int AS count FROM visit_events
       WHERE created_at >= $1 AND created_at <= $2 ${botClause}
       GROUP BY country ORDER BY count DESC LIMIT 25`,
      [q.from, q.to]
    );
    const topRegionsRes = await pool.query(
      `SELECT COALESCE(country || ' / ' || region, country, '(未知)') AS key, COUNT(*)::int AS count
       FROM visit_events
       WHERE created_at >= $1 AND created_at <= $2 ${botClause}
       GROUP BY country, region ORDER BY count DESC LIMIT 25`,
      [q.from, q.to]
    );

    const dailyRes = await pool.query(
      `SELECT (created_at AT TIME ZONE 'UTC')::date::text AS date, COUNT(*)::int AS count
       FROM visit_events
       WHERE created_at >= $1 AND created_at <= $2 ${botClause}
       GROUP BY 1 ORDER BY 1`,
      [q.from, q.to]
    );

    const geoRes = await pool.query(
      `SELECT ROUND(latitude::numeric, 2)::float AS lat,
              ROUND(longitude::numeric, 2)::float AS lng,
              COALESCE(city, '') AS city, COALESCE(country, '') AS country,
              COUNT(*)::int AS count
       FROM visit_events
       WHERE created_at >= $1 AND created_at <= $2
         AND latitude IS NOT NULL AND longitude IS NOT NULL ${botClause}
       GROUP BY 1, 2, city, country
       ORDER BY count DESC LIMIT 500`,
      [q.from, q.to]
    );
    const geoPoints: GeoPoint[] = geoRes.rows.map((r) => ({
      lat: Number(r.lat),
      lng: Number(r.lng),
      count: Number(r.count),
      city: r.city || null,
      country: r.country || null,
    }));

    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS c FROM visit_events
       WHERE created_at >= $1 AND created_at <= $2 ${botClause}`,
      [q.from, q.to]
    );
    const totalRows = Number(countRes.rows[0]?.c) || 0;

    const rowsRes = await pool.query(
      `SELECT * FROM visit_events
       WHERE created_at >= $1 AND created_at <= $2 ${botClause}
       ORDER BY created_at DESC
       LIMIT $3 OFFSET $4`,
      [q.from, q.to, q.pageSize, offset]
    );

    return {
      summary,
      topPaths: topPathsRes.rows.map((r) => ({ key: String(r.key), count: Number(r.count) })),
      topCountries: topCountriesRes.rows.map((r) => ({ key: String(r.key), count: Number(r.count) })),
      topRegions: topRegionsRes.rows.map((r) => ({ key: String(r.key), count: Number(r.count) })),
      daily: dailyRes.rows.map((r) => ({ date: String(r.date), count: Number(r.count) })),
      geoPoints,
      rows: rowsRes.rows.map((row) => mapPgRow(row)),
      totalRows,
    };
  }

  return reportFromRows(await loadJsonlVisits(q.from, q.to, true), q);
}
