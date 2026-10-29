import type { MetadataRoute } from 'next';

// APP_URL est lu à chaque requête : l'image Docker est construite sans configuration.
export const dynamic = 'force-dynamic';

export default function sitemap(): MetadataRoute.Sitemap {
  const base = process.env.APP_URL ?? 'http://localhost:3000';
  return ['/', '/login', '/mentions-legales', '/confidentialite'].map((p) => ({ url: `${base}${p}` }));
}
