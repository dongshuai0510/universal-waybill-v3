import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 是原生模块，仅本地开发用；Vercel 上走 Neon 驱动，不打包 sqlite。
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
