import { defineConfig } from 'vite';

export default defineConfig({
  // relative base → works both at the site root and under /skargard/ on GitHub Pages
  base: './',
  build: {
    target: 'esnext',   // main.js uses top-level await to fetch the chart data
  },
  server: {
    port: 5183,
    strictPort: true,
    host: true,
  },
});
