// NeoLinguaMeet (src/lib/brand.ts): with the new name — the default since
// 2026-10-20, unless NEXT_PUBLIC_BRAND_NAME=neoconference — the icons
// browsers and phones fetch by fixed paths come from
// public/brand/neolinguameet/ (drawn by mobile/tool/web_icons.mjs).
// Redirects run before public files, so the NeoConference ones stay in place.
const MOVED = (process.env.NEXT_PUBLIC_PRIMARY_DOMAIN || "").trim().toLowerCase().replace(/^www\./, "") === "neolinguameet.com";
const LINGUA = MOVED || (process.env.NEXT_PUBLIC_BRAND_NAME || "").trim().toLowerCase() !== "neoconference";
const BRAND_ICONS = {
  "/favicon.ico": "favicon.ico",
  "/icon.png": "icon.png",
  "/apple-icon.png": "apple-touch-icon.png",
  "/apple-touch-icon.png": "apple-touch-icon.png",
  "/apple-touch-icon-precomposed.png": "apple-touch-icon.png",
  "/icons/icon-192.png": "icon-192.png",
  "/icons/icon-512.png": "icon-512.png",
  "/icons/badge-96.png": "badge-96.png",
};

/** @type {import('next').NextConfig} */
const nextConfig = {
    async redirects() {
          if (!LINGUA) return [];
          return Object.entries(BRAND_ICONS).map(([source, file]) => ({
                source,
                destination: `/brand/neolinguameet/${file}`,
                permanent: false,
          }));
    },
    eslint: {
          // Lint errors fail the build (warnings do not). Ignored until the
          // 148-error backlog was cleared; see the `any` sweep that found the
          // meeting summary never reading chat text.
          ignoreDuringBuilds: false,
    },
    typescript: {
          // Type errors fail the build. They were ignored, and 42 sat in
          // every check, so a new one — like the developer API keys route
          // that never saw a signed-in user — deployed unnoticed. Lint is
          // still ignored until its own backlog is cleared.
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
