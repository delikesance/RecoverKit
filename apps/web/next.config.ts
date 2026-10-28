import type { NextConfig } from 'next';
import { securityHeaders } from './src/server/security-headers';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@recoverkit/core', '@recoverkit/db', '@recoverkit/mail', '@recoverkit/services', '@recoverkit/stripe'],
  serverExternalPackages: ['pg', 'pino', 'stripe'],
  async headers() {
    return securityHeaders();
  },
};

export default config;
