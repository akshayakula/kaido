import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  // Load env from parent /kaido dir as well as local
  const sharedEnv = loadEnv(mode, resolve(__dirname, '..'), '');
  const localEnv = loadEnv(mode, __dirname, '');
  const env = { ...sharedEnv, ...localEnv };

  const port = 3000 + (Math.abs(hash(__dirname)) % 1000);

  return {
    define: {
      'import.meta.env.VITE_GOOGLE_MAPS_API_KEY': JSON.stringify(
        env.VITE_GOOGLE_MAPS_API_KEY || env.GOOGLE_API_KEY || ''
      ),
      'import.meta.env.VITE_NASA_FIRMS_MAP_KEY': JSON.stringify(
        env.VITE_NASA_FIRMS_MAP_KEY || env.NASA_FIRMS_MAP_KEY || ''
      ),
    },
    server: {
      port,
      proxy: {
        '/firms': {
          target: 'https://firms.modaps.eosdis.nasa.gov',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/firms/, ''),
        },
      },
    },
  };
});

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
