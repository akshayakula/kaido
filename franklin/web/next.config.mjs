const FRANKLIN_SERVER_URL = process.env.FRANKLIN_SERVER_URL ?? 'http://127.0.0.1:3782';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      // Proxy the static viewer HTML + the /work/<source>/<file>.wav assets it
      // references through to the Flask franklin server. Keeps the viewer
      // reachable from the same origin as the Next.js app.
      { source: '/viewer', destination: `${FRANKLIN_SERVER_URL}/viewer/` },
      { source: '/viewer/', destination: `${FRANKLIN_SERVER_URL}/viewer/` },
      { source: '/viewer/:path*', destination: `${FRANKLIN_SERVER_URL}/viewer/:path*` },
      { source: '/work/:path*',   destination: `${FRANKLIN_SERVER_URL}/work/:path*` },
    ];
  },
};

export default nextConfig;
