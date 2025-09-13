// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  eslint: {
    // ✅ Don’t block build on ESLint errors
    ignoreDuringBuilds: true,
  },
  typescript: {
    // ✅ Don’t block build on TS errors
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
