import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// PKCE redirect target. Supabase sends the user here with a `code` after Google
// sign-in, and also for password recovery and invites when the project's email
// templates use `{{ .ConfirmationURL }}`; we exchange it for a session (which
// sets the auth cookies) and forward to wherever that flow needs to land.
// The `token_hash` variant of those emails goes to /auth/confirm instead.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next')
  const type = searchParams.get('type')

  // A recovery or invite sent from the Supabase dashboard carries no `next`, so
  // defaulting to /dashboard would drop the user there signed in but still
  // without a password. `type` is the only signal we get; honour it.
  const needsPassword = type === 'recovery' || type === 'invite'
  const destination = next ?? (needsPassword ? '/reset-password' : '/dashboard')

  if (code) {
    const supabase = createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) return NextResponse.redirect(`${origin}${destination}`)
  }

  // A failed exchange on the recovery flow means an expired or already-used
  // reset link. Send those to /forgot-password, where requesting a fresh one is
  // the single obvious action — not to /login, which cannot help.
  if (needsPassword || destination === '/reset-password') {
    return NextResponse.redirect(`${origin}/forgot-password?expired=1`)
  }
  return NextResponse.redirect(`${origin}/login?error=oauth`)
}
