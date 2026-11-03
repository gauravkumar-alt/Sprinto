/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["better-sqlite3", "undici"],
  poweredByHeader: false,
};
export default nextConfig;
