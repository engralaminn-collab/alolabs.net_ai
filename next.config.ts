import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ['bcrypt', 'sharp', 'mysql2', 'better-sqlite3', 'pg'],
  poweredByHeader: false,
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**.space-z.ai' },
      { protocol: 'https', hostname: 'cdn.min.io' },
    ],
  },
  allowedDevOrigins: ["https://preview-chat-d1cdb6cf-cc69-4421-aad8-07d2511d9bec.space-z.ai", "http://preview-chat-d1cdb6cf-cc69-4421-aad8-07d2511d9bec.space-z.ai", "https://*.space-z.ai", "http://*.space-z.ai", "127.0.0.1", "localhost", "0.0.0.0"],
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          // Note: 'unsafe-inline' is required for both script-src and style-src in this Next.js app.
          // - script-src: Next.js injects inline scripts for hydration and runtime chunks.
          //   A nonce-based approach can be adopted in a future iteration (via middleware).
          // - style-src: Tailwind CSS dynamically generates styles that require inline support.
          //   Using a hash/nonce strategy here would break Tailwind's runtime behavior.
          { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' wss:; frame-ancestors 'none';" },
        ],
      },
      {
        source: '/api/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
    ];
  },
};

export default nextConfig;
