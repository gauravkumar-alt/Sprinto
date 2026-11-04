/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["better-sqlite3", "undici", "playwright-core"],
  poweredByHeader: false,
  // Lets a dev server run next to a production server without sharing build output.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};
export default nextConfig;
