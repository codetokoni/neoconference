/** @type {import('next').NextConfig} */
const nextConfig = {
    eslint: {
          ignoreDuringBuilds: true,
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
