'use client'
import * as Sentry from '@sentry/nextjs'
import { useEffect } from 'react'

// React render errors never reach the server on their own — without this
// boundary a client-side crash is invisible to monitoring entirely.
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error)
  }, [error])

  return (
    <html lang="en">
      <body>
        <div className="p-8">
          <h2 className="text-lg font-semibold">Something went wrong</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            The error has been reported. Try reloading the page.
          </p>
        </div>
      </body>
    </html>
  )
}
