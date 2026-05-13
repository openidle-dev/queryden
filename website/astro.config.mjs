import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';

export default defineConfig({
  site: 'https://queryden.openidle.com',
  integrations: [mdx()],
  markdown: {
    shikiConfig: {
      theme: 'github-dark-default',
      wrap: true,
    },
  },
  vite: {
    build: {
      rollupOptions: {
        // Pagefind ships its JS into dist/pagefind/ at postbuild time.
        // Tell Vite/Rollup not to try to bundle it.
        external: [/^\/pagefind\//],
      },
    },
  },
});
