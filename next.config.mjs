/** @type {import('next').NextConfig} */
const nextConfig = {
    eslint: {
          ignoreDuringBuilds: true,
    },
    typescript: {
          ignoreBuildErrors: true,
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
