import type { MetadataRoute } from 'next';

export default function sitemap(): MetadataRoute.Sitemap {
  const base = process.env.APP_URL ?? 'http://localhost:3000';
  return ['/', '/login', '/mentions-legales', '/confidentialite'].map((p) => ({ url: `${base}${p}` }));
}
