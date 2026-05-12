/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    // Strict lint at build time. If something breaks, fix the root cause
    // rather than re-enabling this flag.
    ignoreDuringBuilds: false,
  },
  typescript: {
    // Strict type-checking at build time. Same rule as above.
    ignoreBuildErrors: false,
  },
  experimental: {
    // Codespaces forwarded host - update if the Codespace is rebuilt
    serverActions: {
      allowedOrigins: [
        "special-space-potato-5v6vj4v99r4h474p-3000.app.github.dev",
        "localhost:3000",
      ],
    },
  },
};

export default nextConfig;
