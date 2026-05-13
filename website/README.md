# QueryDen website

The marketing site and documentation, deployed at <https://queryden.openidle.com>.

Built with Astro 5 + TypeScript + Tailwind v4 tokens. Dark theme, cyan accent.
Docs use Astro content collections with MDX + Shiki syntax highlighting + Pagefind search.

## Run locally

```bash
npm install
npm run dev          # http://localhost:4321
```

## Add a documentation page

1. Drop an `.mdx` file into the right section folder:

   ```
   src/content/docs/
   ├── getting-started/
   ├── engines/
   ├── editor/
   ├── ai/
   ├── security/
   └── troubleshooting/
   ```

2. Frontmatter is required and validated at build time (`src/content.config.ts`):

   ```yaml
   ---
   title: Run your first query
   description: One-sentence summary for the lede and meta description.
   section: getting-started        # must match the folder name
   order: 30                       # lower numbers sort first in the sidebar
   updated: 2026-05-13             # surfaces on the page header + landing page
   ---
   ```

3. The sidebar, breadcrumbs, prev/next, ToC, and search index update automatically.

4. Need a callout? Import it inside the MDX:

   ```mdx
   import Callout from '../../../components/Callout.astro';

   <Callout type="warn" title="Heads up">
     Body text — supports markdown.
   </Callout>
   ```

   Types: `info` (cyan), `tip` (green), `warn` (amber), `danger` (red).

## Build for production

```bash
npm run build        # astro build, then pagefind --site dist --glob "docs/**/*.html"
npm run preview      # serve dist/ locally to verify pagefind search works
```

The build:
- Generates the static site to `dist/`.
- Runs Pagefind over `dist/docs/**/*.html` to produce the search index at `dist/pagefind/`.
- Fails the build if `QUERYDEN_REQUIRE_LIVE_RELEASE=1` and the GitHub release fetch fails (Vercel production).

## File layout

```
website/
├── astro.config.mjs          MDX integration, Shiki theme, Vite externals for pagefind
├── src/
│   ├── content/
│   │   └── docs/             MDX content, one file per documentation page
│   ├── content.config.ts     Content collection schema (frontmatter validation)
│   ├── components/
│   │   ├── Callout.astro     MDX callout component (info/tip/warn/danger)
│   │   ├── DocsSearch.astro  Pagefind UI trigger + modal
│   │   ├── SignatureMesh.astro
│   │   └── ProductImage.astro
│   ├── layouts/
│   │   ├── Layout.astro      Site-wide chrome (nav, footer)
│   │   └── DocsLayout.astro  3-column docs shell (sidebar, article, ToC)
│   ├── lib/
│   │   ├── docs.ts           Sidebar builder, prev/next, section metadata
│   │   └── site.ts           Single source of truth for version, release, repo URL
│   ├── pages/                Routes
│   └── styles/site.css       Design tokens + base styles
├── audit/                    Codebase audit reports (not deployed)
└── public/
    └── pagefind/             Build artifact mirror for dev parity (git-ignored)
```

## Contributing

See [../CONTRIBUTING.md](../CONTRIBUTING.md#contributing-documentation) for the full guide.
Every documentation page has an "Edit on GitHub" link in its header — typo fixes are a single click.
