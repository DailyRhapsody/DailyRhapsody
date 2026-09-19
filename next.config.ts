import type { NextConfig } from "next";
import { allHttpSecurityHeaders } from "./lib/http-security";

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "prod-files-secure.s3.us-west-2.amazonaws.com",
      },
    ],
  },
  // /blog 与 /moments 是同一页的两个 tab（app/blog）；旧的 /entries 系列地址永久跳转过来，
  // 浏览器会保留原地址的 #entry-… 锚点，分享出去的文章链接照常落到那一篇
  async redirects() {
    return [
      {
        source: "/entries",
        has: [{ type: "query", key: "tab", value: "(moments|gallery)" }],
        destination: "/moments",
        permanent: true,
      },
      { source: "/entries", destination: "/blog", permanent: true },
      { source: "/the-moment", destination: "/moments", permanent: true },
    ];
  },
  async rewrites() {
    return [{ source: "/moments", destination: "/blog" }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: allHttpSecurityHeaders(),
      },
    ];
  },
};

export default nextConfig;
