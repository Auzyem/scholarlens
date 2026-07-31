const { withSentryConfig } = require('@sentry/nextjs')

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['pdf-parse', 'mammoth'],
    // Required on Next 14 for instrumentation.ts to run at all, which is what
    // loads the server/edge Sentry configs. Stable from Next 15.
    instrumentationHook: true,
  },
}

// Only wire up source-map upload when a build-time token is present. CI builds
// and local builds have none and must still succeed — `npm run build` is the
// merge gate, so a hard dependency on a Sentry credential here would block
// every PR.
const sentryEnabled = Boolean(process.env.SENTRY_AUTH_TOKEN)

module.exports = sentryEnabled
  ? withSentryConfig(nextConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      silent: true,
      widenClientFileUpload: true,
      disableLogger: true,
    })
  : nextConfig
