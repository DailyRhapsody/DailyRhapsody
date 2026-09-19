import { Redis } from "@upstash/redis";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export type Profile = {
  name: string;
  signature: string;
  avatar: string;
  headerBg: string;
  /** 首页 / 封面背景；空字符串则用内置默认图 */
  homeCoverUrl: string;
  /** true 时 homeCoverUrl 为视频（MP4/WebM 等） */
  homeCoverIsVideo: boolean;
};

/**
 * 旧默认顶栏图。保存资料时默认值会一并写进 Redis，存量 profile 里多半就是这个路径；
 * 图已换成 /hubble-xdf.webp，读出时按默认处理。
 */
const LEGACY_DEFAULT_HEADER_BG = "/header-bg.png";

const DEFAULT_PROFILE: Profile = {
  name: "DailyRhapsody",
  signature: "君子论迹不论心",
  avatar: "/avatar.png",
  headerBg: "/hubble-xdf.webp",
  homeCoverUrl: "",
  homeCoverIsVideo: false,
};

function normalizeProfile(raw: unknown): Profile {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PROFILE };
  const o = raw as Record<string, unknown>;
  return {
    name: typeof o.name === "string" ? o.name : DEFAULT_PROFILE.name,
    signature: typeof o.signature === "string" ? o.signature : DEFAULT_PROFILE.signature,
    avatar: typeof o.avatar === "string" ? o.avatar : DEFAULT_PROFILE.avatar,
    headerBg:
      typeof o.headerBg === "string" && o.headerBg.trim() !== LEGACY_DEFAULT_HEADER_BG
        ? o.headerBg
        : DEFAULT_PROFILE.headerBg,
    homeCoverUrl:
      typeof o.homeCoverUrl === "string" ? o.homeCoverUrl : DEFAULT_PROFILE.homeCoverUrl,
    homeCoverIsVideo:
      typeof o.homeCoverIsVideo === "boolean"
        ? o.homeCoverIsVideo
        : DEFAULT_PROFILE.homeCoverIsVideo,
  };
}

/**
 * Vercel serverless 的部署目录只读、实例间不共享也不持久，写本地文件的
 * profile 在生产从来存不住（保存必 500，读永远是默认值）。有 KV 凭证时
 * 一律走 Upstash Redis；无凭证的环境（离线本地）退回文件存储。
 */
const redisUrl = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
const redis = redisUrl && redisToken ? new Redis({ url: redisUrl, token: redisToken }) : null;

const PROFILE_KEY = "dr:profile";

const DATA_DIR = join(process.cwd(), "data");
const DATA_FILE = join(DATA_DIR, "profile.json");

async function readFromFile(): Promise<unknown | null> {
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

async function writeToFile(profile: Profile): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(profile, null, 2), "utf8");
}

export async function getProfile(): Promise<Profile> {
  const p = redis
    ? await redis.get<Record<string, unknown>>(PROFILE_KEY)
    : await readFromFile();
  if (p) return normalizeProfile(p);
  return { ...DEFAULT_PROFILE };
}

export async function saveProfile(updates: Partial<Profile>): Promise<Profile> {
  const current = await getProfile();
  const filtered: Partial<Profile> = {};
  for (const [k, v] of Object.entries(updates)) {
    if (v !== undefined) (filtered as Record<string, unknown>)[k] = v;
  }
  const next: Profile = normalizeProfile({ ...current, ...filtered });
  if (redis) await redis.set(PROFILE_KEY, next);
  else await writeToFile(next);
  return next;
}
