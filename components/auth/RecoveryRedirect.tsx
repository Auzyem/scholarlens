'use client'
import { useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

// A URL fragment is never sent to the server, so the implicit-flow shape
// (`<Site URL>/#access_token=…&type=recovery`, still emitted by older Supabase
// email templates) is invisible to every route handler we have. It can only be
// caught in the browser, which is what this does.
//
// It cannot be caught by simply letting the client's detectSessionInUrl eat the
// fragment, which is the obvious thing to reach for: @supabase/ssr hardcodes
// `flowType: 'pkce'` on the browser client, and GoTrueClient rejects an implicit
// callback under that flow type outright ("Not a valid PKCE flow url"). So we
// read the tokens out of the fragment and hand them to setSession, which stores
// them through the same cookie storage the rest of the app already reads — the
// server sees the session too, which a hand-rolled client would not give us.
export function RecoveryRedirect() {
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    // Already where we want them; navigating again would only loop.
    if (pathname === '/reset-password') return

    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const type = fragment.get('type')
    // Every other page load has no recovery marker and must not notice we exist.
    if (type !== 'recovery' && type !== 'invite') return

    const accessToken = fragment.get('access_token')
    const refreshToken = fragment.get('refresh_token')

    let cancelled = false
    void (async () => {
      if (accessToken && refreshToken) {
        try {
          await createClient().auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          })
        } catch {}
      }
      if (cancelled) return
      // Drop the spent tokens from the address bar before we move on, keeping
      // Next's own history state intact so back/forward still works.
      window.history.replaceState(
        window.history.state,
        '',
        window.location.pathname + window.location.search
      )
      // Navigate even if the exchange failed: /reset-password is the page that
      // knows how to say "this link is dead", and it says it better than the
      // marketing page does.
      router.replace('/reset-password')
    })()
    return () => { cancelled = true }
  }, [pathname, router])

  return null
}
