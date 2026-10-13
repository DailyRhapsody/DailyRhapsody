import type { NextConfig } from "next";
import { allHttpSecurityHeaders } from "./lib/http-security";

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  // next dev 默认只信任 localhost 来源。从手机用 .local 主机名访问本机开发服务器时，
  // 跨源的 /_next/webpack-hmr 会被拦掉：页面照常服务端渲染（看得见），但 dev 客户端
  // 起不来，交互可能静默失效。手机调试因此登记 .local。
  //
  // 刻意不写死局域网 IP：换网络就变了，写进公开仓库只会变成一个很快过期的值。
  // 用 http://<你的主机名>.local:3000 访问，mDNS 自己解析到当前 IP。
  // 只影响 next dev，不进构建产物，生产路由不受影响。
  allowedDevOrigins: ["*.local", "127.0.0.1"],
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
