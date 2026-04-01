import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    externalDir: true,
  },
  transpilePackages: ["@tg-back/db"],
};

export default nextConfig;
