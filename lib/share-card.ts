/**
 * 前台「分享为图」：离屏 DOM，风格对齐 flomo 类卡片（品牌为 DailyRhapsody）。
 */

export type ShareCardInput = {
  summary: string;
  date: string;
  publishedAt?: string;
  entryId: string | number;
  authorName: string;
  tags?: string[];
};

const CARD_WIDTH_PX = 340;
const DEFAULT_SHARE_AUTHOR_LABEL = "DailyRhapsody";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 正文展示用：去掉常见 Markdown，保留换行 */
export function summaryToPlainForCard(summary: string): string {
  let t = summary.trim();
  if (!t) return " ";
  t = t.replace(/^#{1,6}\s+/gm, "");
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
  t = t.replace(/\*([^*]+)\*/g, "$1");
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // 列表标记可能带缩进（嵌套列表），必须容忍前导空白，否则分享图里会留下 "- " 与空格
  t = t.replace(/^[ \t]*[-*+]\s+\[[ xX]\]\s+/gm, "");
  t = t.replace(/^[ \t]*[-*+]\s+/gm, "");
  t = t.replace(/^[ \t]*\d+\.\s+/gm, "");
  t = t.replace(/^[ \t]*>[ \t]?/gm, "");
  // toggle 的标题是正文，只去掉标记本身；callout 的标记行只有图标，整行去掉
  t = t.replace(/\[!NOTION-CALLOUT\][^\n]*/g, "");
  t = t.replace(/\[!NOTION-TOGGLE\][ \t]*/g, "");
  t = t.replace(/<\/?(?:details|summary|div)[^>]*>/gi, "");
  t = t.replace(/`{3}[\s\S]*?`{3}/g, "");
  t = t.replace(/`([^`]+)`/g, "$1");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim() || " ";
}

export function getCardDateParts(
  date: string,
  publishedAt?: string
): { day: string; yearMonth: string } {
  const raw = publishedAt?.trim() || `${date}T12:00:00`;
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) {
    const day = String(d.getDate());
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    return { day, yearMonth: `${y}.${m}` };
  }
  const p = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (p) {
    const y = p[1];
    const m = p[2];
    const dd = String(parseInt(p[3], 10));
    return { day: dd, yearMonth: `${y}.${m}` };
  }
  return { day: "1", yearMonth: "1970.01" };
}

/**
 * 创建可交给 html2canvas 的卡片根节点（需已挂载到 document 再截图）。
 */
export function createShareCardElement(props: ShareCardInput): HTMLDivElement {
  const body = summaryToPlainForCard(props.summary);
  const { day, yearMonth } = getCardDateParts(props.date, props.publishedAt);
  const authorTrimmed = props.authorName.trim();
  const showAuthorLine =
    authorTrimmed.length > 0 && authorTrimmed !== DEFAULT_SHARE_AUTHOR_LABEL;
  const bodyHtml = escapeHtml(body).replace(/\n/g, "<br/>");
  const shortId = typeof props.entryId === "number"
    ? props.entryId
    : props.entryId.slice(0, 8);
  const subtitle = `Chapter. ${shortId}`;

  const root = document.createElement("div");
  root.setAttribute("data-dailyrhapsody-share-card", "1");
  root.style.cssText = [
    "box-sizing:border-box",
    `width:${CARD_WIDTH_PX}px`,
    "padding:36px 34px 30px",
    "background:linear-gradient(180deg,#FDF7F7 0%,#FAF8F7 35%,#F4F6F6 70%,#F0F4F4 100%)",
    'font-family:system-ui,-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif',
    "-webkit-font-smoothing:antialiased",
    "color:#333333",
  ].join(";");

  const dateBox = document.createElement("div");
  dateBox.style.cssText = [
    "box-sizing:border-box",
    "position:relative",
    "width:56px",
    "height:52px",
    "border:1px solid #dddddd",
    "padding:0 4px",
    "background:rgba(255,255,255,0.38)",
    "overflow:hidden",
  ].join(";");

  const dateInner = document.createElement("div");
  dateInner.style.cssText = [
    "position:absolute",
    "left:50%",
    "top:50%",
    "transform:translate(-50%,calc(-50% - 8px))",
    "text-align:center",
    "white-space:nowrap",
  ].join(";");

  const dayEl = document.createElement("div");
  dayEl.textContent = day;
  dayEl.style.cssText =
    "font-size:26px;font-weight:700;line-height:26px;color:#333333;letter-spacing:-0.02em";

  const monthEl = document.createElement("div");
  monthEl.textContent = yearMonth;
  monthEl.style.cssText =
    "font-size:11px;font-weight:400;color:#888888;line-height:13px;margin-top:2px";

  dateInner.appendChild(dayEl);
  dateInner.appendChild(monthEl);
  dateBox.appendChild(dateInner);

  const main = document.createElement("div");
  main.style.cssText = [
    "margin-top:26px",
    "font-size:15px",
    "font-weight:400",
    "line-height:1.58",
    "color:#333333",
    "word-break:break-word",
  ].join(";");
  main.innerHTML = bodyHtml;

  const tags = (props.tags ?? [])
    .map((t) => String(t).trim())
    .filter((t) => t.length > 0);
  let tagRow: HTMLDivElement | null = null;
  if (tags.length > 0) {
    tagRow = document.createElement("div");
    tagRow.style.cssText = [
      "margin-top:14px",
      "display:flex",
      "flex-wrap:wrap",
      "gap:6px",
      "align-items:center",
    ].join(";");
    for (let i = 0; i < tags.length; i++) {
      const tagText = tags[i];
      const chip = document.createElement("span");
      chip.style.cssText = [
        "display:inline-block",
        "position:relative",
        "box-sizing:border-box",
        "height:24px",
        "min-width:32px",
        "padding:0 10px",
        "background:rgba(228,228,231,0.85)",
        "border-radius:9999px",
        "vertical-align:middle",
      ].join(";");
      const inner = document.createElement("span");
      inner.textContent = tagText;
      inner.style.cssText = [
        "position:absolute",
        "left:50%",
        "top:50%",
        "transform:translate(-50%,calc(-50% - 7px))",
        "font-size:11px",
        "font-weight:500",
        "color:#52525b",
        "white-space:nowrap",
        "line-height:11px",
      ].join(";");
      chip.appendChild(inner);
      tagRow.appendChild(chip);
    }
  }

  const hr = document.createElement("div");
  hr.style.cssText = tagRow
    ? "margin:18px 0 0;height:1px;background:#dddddd;width:100%"
    : "margin:26px 0 0;height:1px;background:#dddddd;width:100%";

  const footer = document.createElement("div");
  footer.style.marginTop = "18px";

  const authorLine = document.createElement("div");
  authorLine.style.cssText =
    "font-size:14px;font-weight:600;color:#a3a3a3;line-height:1.35;margin-bottom:8px";
  authorLine.textContent = authorTrimmed;

  const footerBottomRow = document.createElement("div");
  footerBottomRow.style.cssText = [
    "display:flex",
    "flex-direction:row",
    "justify-content:space-between",
    "align-items:baseline",
    "gap:12px",
  ].join(";");

  const chapterEl = document.createElement("span");
  chapterEl.textContent = subtitle;
  chapterEl.style.cssText =
    "font-size:11px;font-weight:400;color:#b8b8b8;line-height:1.35;flex:1;min-width:0";

  const brand = document.createElement("span");
  brand.textContent = "DailyRhapsody";
  brand.style.cssText = [
    "flex-shrink:0",
    "font-size:13px",
    "font-weight:700",
    "color:#a8a8a8",
    "line-height:1.35",
    "letter-spacing:-0.02em",
  ].join(";");

  footerBottomRow.appendChild(chapterEl);
  footerBottomRow.appendChild(brand);
  if (showAuthorLine) footer.appendChild(authorLine);
  footer.appendChild(footerBottomRow);

  root.appendChild(dateBox);
  root.appendChild(main);
  if (tagRow) root.appendChild(tagRow);
  root.appendChild(hr);
  root.appendChild(footer);

  return root;
}

export { CARD_WIDTH_PX as SHARE_CARD_WIDTH_PX };
