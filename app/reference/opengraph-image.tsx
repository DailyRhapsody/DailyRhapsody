import { ImageResponse } from "next/og";

export const alt = "DailyRhapsody Reference · 机器人行业资料库";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * Reference 的稳定分享图。刻意只用拉丁字符：Satori 不带系统字体，
 * 中文需要额外打包 CJK 子集；P0 先用英文品牌图，避免为了几个字塞 1–2MB 字体。
 */
export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px",
          background: "linear-gradient(135deg, #09090b 0%, #18181b 55%, #27272a 100%)",
          color: "#fafafa",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div
            style={{
              width: 46,
              height: 46,
              borderRadius: 999,
              border: "2px solid #a1a1aa",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 22,
            }}
          >
            R
          </div>
          <div style={{ fontSize: 24, letterSpacing: 4, color: "#a1a1aa" }}>
            DAILYRHAPSODY
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ fontSize: 30, color: "#a1a1aa", letterSpacing: 2 }}>
            ROBOTICS · INDUSTRY REFERENCE
          </div>
          <div style={{ fontSize: 78, fontWeight: 700, lineHeight: 1.05 }}>
            Reference
          </div>
          <div style={{ fontSize: 28, color: "#d4d4d8" }}>
            Papers · Reports · Tests · Interviews
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 22, color: "#71717a" }}>
          <span>tengjun.org/reference</span>
          <span>Open industry library</span>
        </div>
      </div>
    ),
    size,
  );
}
