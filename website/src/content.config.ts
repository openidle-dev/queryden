import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const docs = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/docs' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
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
