import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    host: '127.0.0.1',
    // `npm run dev` reaches a locally running `node server.mjs` for the party socket, so the
    // client can derive the socket URL from `location` in development exactly as in production.
    proxy: {
      '/party': { target: 'http://127.0.0.1:4318', ws: true },
    },
  },
});
