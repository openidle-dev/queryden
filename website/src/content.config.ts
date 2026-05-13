import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const docs = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/docs' }),
  schema: z.object({
    title: z.string(),
    // Required for SEO: every doc needs a unique meta description. Don't
    // weaken to .optional() — falling back to the site-wide default hurts
    // per-page search ranking.
    description: z.string().min(20).max(180),
    section: z.enum([
      'getting-started',
      'engines',
      'editor',
      'ai',
      'security',
      'troubleshooting',
    ]),
    order: z.number().default(100),
    draft: z.boolean().default(false),
    updated: z.coerce.date().optional(),
  }),
});

export const collections = { docs };
