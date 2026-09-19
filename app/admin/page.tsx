"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { formatDate12h } from "@/lib/format";
import {
  clearAdminListRestoreIntent,
  persistAdminListState,
  shouldRestoreAdminList,
  readAdminListState,
} from "@/lib/admin-list-restore";
import { markdownPreviewProseClass, renderMarkdown } from "@/lib/markdown";
import Pagination from "../components/Pagination";
import ImageUpload from "./ImageUpload";
import HomeCoverUpload from "./HomeCoverUpload";

type Diary = {
  id: number;
  date: string;
  publishedAt?: string;
  isPublic?: boolean;
  summary: string;
  location?: string;
  tags?: string[];
  pinned?: boolean;
};

type Profile = {
  name: string;
  signature: string;
  avatar: string;
  headerBg: string;
  homeCoverUrl: string;
  homeCoverIsVideo: boolean;
};

const PAGE_SIZE = 20;
const MAX_SUMMARY_LINES = 5;
/** 搜索防抖：仅下方列表随防抖后的关键词请求，避免整页跟着抖 */
const SEARCH_DEBOUNCE_MS = 320;
/** 与 lib/profile-store 默认一致；用于后台预览是否算「自定义顶栏」 */
const DEFAULT_ENTRY_HEADER_BG = "/header-bg.png";

function getSizeClass(count: number, maxCount: number) {
  if (maxCount <= 0) return "text-xs";
  const r = count / maxCount;
  if (r >= 0.7) return "text-base sm:text-lg";
  if (r >= 0.4) return "text-sm sm:text-base";
  if (r >= 0.2) return "text-xs sm:text-sm";
  return "text-[0.65rem] sm:text-xs";
}

function AdminSummary({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const needsExpand =
    text.split(/\n/).length > MAX_SUMMARY_LINES || text.length > 280;
  const rendered = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div>
      <div
        className={`${markdownPreviewProseClass} text-[0.8125rem] leading-relaxed text-zinc-600 dark:text-zinc-400 ${
          expanded ? "" : "line-clamp-6"
        }`}
      >
        <div
          className="space-y-[1.15em]"
          dangerouslySetInnerHTML={{ __html: rendered }}
        />
      </div>
      {needsExpand && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mt-1 text-[0.75rem] text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
        >
          {expanded ? "收起" : "展开"}
        </button>
      )}
    </div>
  );
}

function AdminCard({
  d,
  onRemove,
  onBeforeNavigateToEdit,
}: {
  d: Diary;
  onRemove: (id: number) => void;
  onBeforeNavigateToEdit?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const timeStr = formatDate12h(d.publishedAt ?? d.date + "T12:00:00");

  return (
    <article className="group relative flex flex-col gap-3 rounded-2xl px-3 py-4 transition-apple hover:bg-zinc-100/70 hover:shadow-md dark:hover:bg-zinc-900/80 dark:hover:shadow-black/10">
      <div className="flex items-start gap-3">
        <div className="min-h-10 flex min-w-0 flex-1 flex-col justify-center">
          <p className="text-[0.75rem] text-zinc-500 dark:text-zinc-400">
            {timeStr}
          </p>
        </div>
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            className="rounded-full p-1.5 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-300"
            aria-label="更多"
          >
            <svg
              className="h-5 w-5"
              fill="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <circle cx="12" cy="6" r="1.5" />
              <circle cx="12" cy="12" r="1.5" />
              <circle cx="12" cy="18" r="1.5" />
            </svg>
          </button>
          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-40"
                aria-hidden="true"
                onClick={() => setMenuOpen(false)}
              />
              <div className="absolute right-0 top-full z-50 mt-1 min-w-[6rem] rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                <Link
                  href={`/admin/diaries/${d.id}/edit`}
                  className="block w-full px-3 py-2 text-left text-[0.8rem] text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  onClick={() => {
                    onBeforeNavigateToEdit?.();
                    setMenuOpen(false);
                  }}
                >
                  编辑
                </Link>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onRemove(d.id);
                  }}
                  className="w-full px-3 py-2 text-left text-[0.8rem] text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
                >
                  删除
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      {d.pinned && (
        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[0.65rem] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
          置顶
        </span>
      )}
      {d.isPublic === false && (
        <span className="w-fit rounded bg-zinc-200/80 px-1.5 py-0.5 text-[0.65rem] text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">
          私密
        </span>
      )}
      <AdminSummary text={d.summary || ""} />
      <div className="flex items-center justify-between gap-2">
        {(d.tags ?? []).length > 0 ? (
          <div className="min-w-0 flex flex-wrap gap-1">
            {(d.tags ?? []).map((tag) => (
              <span
                key={tag}
                className="rounded bg-zinc-200/80 px-1.5 py-0.5 text-[0.65rem] text-zinc-600 dark:bg-zinc-700 dark:text-zinc-400"
              >
                {tag}
              </span>
            ))}
          </div>
        ) : (
          <div />
        )}
        {d.location && (
          <span className="max-w-[48%] shrink-0 truncate text-right text-[0.72rem] text-zinc-500 dark:text-zinc-400">
            📍 {d.location}
          </span>
        )}
      </div>
    </article>
  );
}

export default function AdminPage() {
  const [diaries, setDiaries] = useState<Diary[]>([]);
  const [total, setTotal] = useState(0);
  const [tagCounts, setTagCounts] = useState<{ name: string; value: number }[]>([]);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [tagDeleting, setTagDeleting] = useState<string | null>(null);
  const [tagRenaming, setTagRenaming] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileDraft, setProfileDraft] = useState<Profile | null>(null);
  const [profileEditing, setProfileEditing] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  /** 输入搜索等二次请求：不整页替换为「加载中」，避免闪烁 */
  const [listFetching, setListFetching] = useState(false);
  const [page, setPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  /** Enter 立即搜索：与防抖值相同时也触发一次列表刷新 */
  const [searchCommitNonce, setSearchCommitNonce] = useState(0);
  const scrollPersistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoredPageRef = useRef(false);
  const loadAbortRef = useRef<AbortController | null>(null);
  const listFetchInitRef = useRef(false);
  const prevSearchRef = useRef<string | undefined>(undefined);
  const prevTagRef = useRef<string | null | undefined>(undefined);

  const flushListScrollPosition = useCallback(() => {
    persistAdminListState({
      page,
      searchQuery,
      scrollY: typeof window !== "undefined" ? window.scrollY : 0,
    });
  }, [page, searchQuery]);

  const load = useCallback(
    (pageNum: number, q: string, showFullPageLoading = false) => {
      loadAbortRef.current?.abort();
      const ac = new AbortController();
      loadAbortRef.current = ac;
      setListFetching(true);
      if (showFullPageLoading) setLoading(true);
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String((pageNum - 1) * PAGE_SIZE),
      });
      const qt = q.trim();
      if (qt) params.set("q", qt);
      if (selectedTag) params.set("tag", selectedTag);
      fetch(`/api/diaries?${params}`, { signal: ac.signal })
        .then((res) => {
          if (!res.ok) throw new Error(String(res.status));
          return res.json();
        })
        .then((data: { items?: Diary[]; total?: number; tagCounts?: { name: string; value: number }[] }) => {
          setDiaries(Array.isArray(data.items) ? data.items : []);
          setTotal(typeof data.total === "number" ? data.total : 0);
          if (Array.isArray(data.tagCounts)) setTagCounts(data.tagCounts);
        })
        .catch((err: unknown) => {
          if (err instanceof Error && err.name === "AbortError") return;
          setDiaries([]);
          setTotal(0);
        })
        .finally(() => {
          if (ac.signal.aborted) return;
          setListFetching(false);
          if (showFullPageLoading) setLoading(false);
        });
    },
    [selectedTag],
  );

  useEffect(() => {
    return () => loadAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [searchQuery]);

  useEffect(() => {
    if (!listFetchInitRef.current) {
      listFetchInitRef.current = true;
      prevSearchRef.current = debouncedSearchQuery;
      prevTagRef.current = selectedTag;
      load(page, debouncedSearchQuery, true);
      return;
    }

    const searchChanged = prevSearchRef.current !== debouncedSearchQuery;
    const tagChanged = prevTagRef.current !== selectedTag;
    if (searchChanged) prevSearchRef.current = debouncedSearchQuery;
    if (tagChanged) prevTagRef.current = selectedTag;

    if ((searchChanged || tagChanged) && page !== 1) {
      setPage(1);
      return;
    }
    load(page, debouncedSearchQuery);
  }, [load, page, debouncedSearchQuery, selectedTag, searchCommitNonce]);

  useLayoutEffect(() => {
    if (restoredPageRef.current) return;
    if (!shouldRestoreAdminList()) return;
    const s = readAdminListState();
    if (!s) return;
    restoredPageRef.current = true;
    setPage(s.page);
    setSearchQuery(s.searchQuery);
    setDebouncedSearchQuery(s.searchQuery);
  }, []);

  useEffect(() => {
    persistAdminListState({
      page,
      searchQuery,
      scrollY: typeof window !== "undefined" ? window.scrollY : 0,
    });
  }, [page, searchQuery]);

  useEffect(() => {
    const onScroll = () => {
      if (scrollPersistTimer.current) clearTimeout(scrollPersistTimer.current);
      scrollPersistTimer.current = setTimeout(() => {
        persistAdminListState({
          page,
          searchQuery,
          scrollY: window.scrollY,
        });
      }, 120);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (scrollPersistTimer.current) clearTimeout(scrollPersistTimer.current);
    };
  }, [page, searchQuery]);

  useEffect(() => {
    if (loading) return;
    if (!shouldRestoreAdminList()) return;
    const s = readAdminListState();
    const y = s?.scrollY ?? 0;
    window.scrollTo(0, y);
    requestAnimationFrame(() => window.scrollTo(0, y));
    const t = window.setTimeout(() => clearAdminListRestoreIntent(), 300);
    return () => clearTimeout(t);
  }, [loading]);

  useEffect(() => {
    fetch("/api/profile")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: Profile | null) =>
        setProfile(
          data
            ? {
                ...data,
                homeCoverUrl: data.homeCoverUrl ?? "",
                homeCoverIsVideo: data.homeCoverIsVideo ?? false,
              }
            : null,
        ),
      )
      .catch(() => setProfile(null));
  }, []);

  const handleSearch = useCallback(() => {
    setDebouncedSearchQuery(searchQuery);
    setPage(1);
    setSearchCommitNonce((n) => n + 1);
  }, [searchQuery]);

  // 已移除：一次性迁移用的「同步 WordPress 时间」与「仅首次初始化」。

  const maxTagCount = tagCounts[0]?.value ?? 1;
  const handleTagClick = (tag: string) => {
    setPage(1);
    setSelectedTag((prev) => (prev === tag ? null : tag));
  };

  async function deleteTag(tag: string) {
    if (!confirm(`确定删除标签「${tag}」？这会从所有文章正文中移除 #${tag}，不可撤销。`)) return;
    setTagDeleting(tag);
    try {
      const res = await fetch("/api/admin/tags/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        alert(data?.error ?? "删除失败");
        return;
      }
      setSelectedTag((cur) => (cur === tag ? null : cur));
      load(1, debouncedSearchQuery);
    } catch {
      alert("删除失败：网络或服务异常");
    } finally {
      setTagDeleting(null);
    }
  }

  async function renameTag(from: string) {
    const toInput = window.prompt(`将标签「${from}」重命名为（合并到已有标签时填目标名）：`, from);
    if (toInput === null) return;
    const to = toInput.trim();
    if (!to) {
      alert("名称不能为空");
      return;
    }
    if (to === from) return;
    if (
      !confirm(
        `确定将「${from}」改为「${to}」？\n· 各篇正文中 #${from} 会改为 #${to}；若该篇已有 #${to}，则仅删除 #${from}。`,
      )
    ) {
      return;
    }
    setTagRenaming(from);
    try {
      const res = await fetch("/api/admin/tags/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        alert((data as { error?: string } | null)?.error ?? "重命名失败");
        return;
      }
      setSelectedTag((cur) => (cur === from ? null : cur));
      load(page, debouncedSearchQuery);
    } catch {
      alert("重命名失败：网络或服务异常");
    } finally {
      setTagRenaming(null);
    }
  }

  async function remove(id: number) {
    if (!confirm("确定删除这篇？")) return;
    const res = await fetch(`/api/diaries/${id}`, { method: "DELETE" });
    if (res.ok) load(page, debouncedSearchQuery);
  }

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    if (!profileDraft) return;
    setProfileSaving(true);
    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profileDraft),
      });
      if (res.ok) {
        setProfile(await res.json());
        setProfileEditing(false);
        setProfileDraft(null);
      } else {
        alert(`保存失败（HTTP ${res.status}），请重试`);
      }
    } catch {
      alert("保存失败：网络错误，请重试");
    } finally {
      setProfileSaving(false);
    }
  }

  function startEditProfile() {
    if (!profile) return;
    setProfileDraft({
      ...profile,
      homeCoverUrl: profile.homeCoverUrl ?? "",
      homeCoverIsVideo: profile.homeCoverIsVideo ?? false,
    });
    setProfileEditing(true);
  }

  function cancelEditProfile() {
    setProfileEditing(false);
    setProfileDraft(null);
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      {profile && (
        <section className="relative mb-8 rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          {!profileEditing && (
            <>
              <button
                type="button"
                onClick={startEditProfile}
                className="absolute right-4 top-4 rounded-lg border border-zinc-300 p-2 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                aria-label="编辑资料"
                title="编辑资料"
              >
                <svg
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                  />
                </svg>
              </button>
              <div className="min-w-0 pr-14">
                <p className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
                  {profile.name?.trim() || "—"}
                </p>
                {profile.signature?.trim() ? (
                  <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{profile.signature}</p>
                ) : null}
                <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-500">
                  {profile.homeCoverUrl?.trim()
                    ? profile.homeCoverIsVideo
                      ? "已自定义 · 视频封面"
                      : "已自定义 · 图片封面"
                    : "站点默认封面"}
                </p>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
                  {(() => {
                    const hg = profile.headerBg?.trim() ?? "";
                    const custom = hg.length > 0 && hg !== DEFAULT_ENTRY_HEADER_BG;
                    return custom ? "已自定义 · 文章页顶栏图" : "默认文章页顶栏";
                  })()}
                </p>
              </div>
            </>
          )}

          {profileEditing && profileDraft && (
            <form onSubmit={saveProfile} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">姓名</label>
                <input
                  type="text"
                  value={profileDraft.name}
                  onChange={(e) => setProfileDraft((p) => (p ? { ...p, name: e.target.value } : p))}
                  className="mt-1 w-full max-w-md rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-zinc-900 dark:border-zinc-700 dark:text-zinc-50"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">签名</label>
                <input
                  type="text"
                  value={profileDraft.signature}
                  onChange={(e) => setProfileDraft((p) => (p ? { ...p, signature: e.target.value } : p))}
                  placeholder="君子论迹不论心"
                  className="mt-1 w-full max-w-md rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-zinc-900 dark:border-zinc-700 dark:text-zinc-50"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">头像</label>
                <div className="mt-1">
                  <ImageUpload
                    value={profileDraft.avatar ? [profileDraft.avatar] : []}
                    onChange={(urls) => setProfileDraft((p) => (p ? { ...p, avatar: urls[0] ?? "" } : p))}
                    maxCount={1}
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">首页背景（/）</label>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  支持图片或短视频；留空则使用站点默认封面图
                </p>
                <div className="mt-1">
                  <HomeCoverUpload
                    url={profileDraft.homeCoverUrl ?? ""}
                    isVideo={profileDraft.homeCoverIsVideo ?? false}
                    onChange={(url, isVideo) =>
                      setProfileDraft((p) => (p ? { ...p, homeCoverUrl: url, homeCoverIsVideo: isVideo } : p))
                    }
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  文章页顶栏背景（/blog）
                </label>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  博客列表与单篇阅读时顶部粘性栏背景图；留空则用内置默认图
                </p>
                <div className="mt-1">
                  <ImageUpload
                    value={profileDraft.headerBg ? [profileDraft.headerBg] : []}
                    onChange={(urls) => setProfileDraft((p) => (p ? { ...p, headerBg: urls[0] ?? "" } : p))}
                    maxCount={1}
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={profileSaving}
                  className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
                >
                  {profileSaving ? "保存中…" : "保存个人信息"}
                </button>
                <button
                  type="button"
                  onClick={cancelEditProfile}
                  className="rounded-lg border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  取消
                </button>
              </div>
            </form>
          )}
        </section>
      )}

      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
          文章列表（共 {total} 篇）
        </h1>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/admin/diaries/new"
            onClick={flushListScrollPosition}
            className="inline-flex items-center justify-center rounded-lg bg-zinc-900 p-2 text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            aria-label="新建文章"
            title="新建文章"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
          </Link>
        </div>
      </div>

      {/* 标签词云：筛选 + 删除标签 */}
      {tagCounts.length > 0 && (
        <section className="mb-6 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex flex-wrap items-center gap-2">
            {tagCounts.map(({ name, value }) => (
              <div key={name} className="group relative inline-flex items-center">
                <button
                  type="button"
                  onClick={(e) => {
                    if (e.detail === 2) {
                      void renameTag(name);
                      return;
                    }
                    handleTagClick(name);
                  }}
                  className={`rounded-full px-2.5 py-1 pr-7 transition-apple focus:outline-none focus:ring-2 focus:ring-zinc-400 focus:ring-offset-2 focus:ring-offset-white dark:focus:ring-offset-zinc-900 ${getSizeClass(value, maxTagCount)} ${
                    selectedTag === name
                      ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 hover:scale-105 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                  }`}
                  title={`共 ${value} 篇`}
                  disabled={tagDeleting !== null || tagRenaming !== null}
                >
                  {name}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    deleteTag(name);
                  }}
                  disabled={tagDeleting !== null || tagRenaming !== null}
                  className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full bg-black/10 p-1 text-zinc-600 opacity-0 transition group-hover:opacity-100 hover:bg-black/15 disabled:opacity-40 dark:bg-white/10 dark:text-zinc-300 dark:hover:bg-white/15"
                  aria-label={`删除标签 ${name}`}
                >
                  <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
          {selectedTag && (
            <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
              当前筛选：{selectedTag}（共 {total} 篇）
              <button
                type="button"
                onClick={() => handleTagClick(selectedTag)}
                className="ml-2 rounded underline transition-apple hover:opacity-80 focus:outline-none focus:ring-2 focus:ring-zinc-400 focus:ring-offset-2"
              >
                取消
              </button>
            </p>
          )}
          {tagDeleting && (
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              正在删除标签：{tagDeleting}…
            </p>
          )}
          {tagRenaming && (
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              正在重命名标签：{tagRenaming}…
            </p>
          )}
        </section>
      )}

      <div className="mb-4">
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleSearch();
            }
          }}
          className="w-full min-w-0 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
        />
      </div>

      {loading ? (
        <p className="text-zinc-500">加载中…</p>
      ) : (
        <section
          className={`transition-opacity duration-150 ${
            listFetching ? "pointer-events-none opacity-60" : "opacity-100"
          }`}
          aria-busy={listFetching}
          aria-label="文章列表"
        >
          {listFetching && (
            <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400" aria-live="polite">
              列表更新中…
            </p>
          )}
          <ul className="entries-page-fade-in space-y-4">
            {diaries.map((d) => (
              <li key={d.id}>
                <AdminCard
                  d={d}
                  onRemove={remove}
                  onBeforeNavigateToEdit={flushListScrollPosition}
                />
              </li>
            ))}
          </ul>
          {diaries.length === 0 && (
            <p className="py-8 text-center text-sm text-zinc-500">暂无文章</p>
          )}

          {total > 0 && (
            <Pagination
              page={page}
              totalPages={totalPages}
              totalPosts={total}
              onPageChange={setPage}
            />
          )}
        </section>
      )}
    </div>
  );
}
