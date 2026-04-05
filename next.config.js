/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable HTTPS in development for camera access
  // Note: You may need to install @next/bundle-analyzer or use a tool like mkcert
  // For now, using localhost should work for camera access
  //
  // Expose API base URL to the browser (public)
  env: {
    API_ENDPOINT: process.env.API_ENDPOINT,
  },
}

module.exports = nextConfig

