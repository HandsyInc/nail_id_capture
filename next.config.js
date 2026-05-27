/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    API_ENDPOINT: process.env.API_ENDPOINT,
  },
  async headers() {
    return [
      {
        // Apply to both the capture routes so the policy travels with any
        // page that calls getUserMedia, not just capture-v2.
        source: '/:path(capture.*)',
        headers: [
          // camera=* allows this page to request camera access.
          // microphone=() blocks microphone — we never request it.
          { key: 'Permissions-Policy', value: 'camera=*, microphone=()' },
        ],
      },
    ];
  },
}

module.exports = nextConfig

