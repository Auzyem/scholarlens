/**
 * Loads the server- and edge-runtime Sentry configs.
 *
 * This file is REQUIRED, and its absence fails silently in the worst way.
 * `sentry.client.config.ts` is bundled for the browser by the webpack plugin,
 * so the client SDK works without it — but from @sentry/nextjs v8 onward the
 * server and edge configs are only ever loaded through this hook. Without it
 * there is no server-side Sentry client at all: `captureException` still
 * returns an event id, so everything *looks* fine, while nothing is sent.
 *
 * That is exactly what happened here. The production smoke test reported
 * `delivered: false` while the client bundle carried a valid DSN — meaning the
 * pipelines, the API routes and every `mustWrite` call, which are the whole
 * point of the monitoring work, were reporting into a void.
 *
 * On Next 14 this hook needs `experimental.instrumentationHook: true` in
 * next.config.js. It became stable in Next 15.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config')
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config')
  }
}
