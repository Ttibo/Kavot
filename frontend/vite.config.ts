import { defineConfig } from 'vite';
export default defineConfig({
  root: decodeURIComponent(new URL('.', import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, ''),
  base: './',
  publicDir: false,
  // Keep hashed assets referenced by already-open desktop windows after a rebuild.
  // Cleaning this directory while Kavot is open breaks lazy PDF/graph imports.
  build: { outDir: 'static', emptyOutDir: false, assetsDir: 'assets', target: 'es2022' },
  server: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:8000' } },
});
