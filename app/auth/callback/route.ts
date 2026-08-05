import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// OAuth redirect target. Supabase sends the user here with a `code` after Google
// sign-in; we exchange it for a session (which sets the auth cookies) and bounce
// to the dashboard.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/dashboard'

  if (code) {
    const supabase = createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) return NextResponse.redirect(`${origin}${next}`)
  }

  // A failed exchange on the recovery flow means an expired or already-used
  // reset link. Send those to /forgot-password, where requesting a fresh one is
  // the single obvious action — not to /login, which cannot help.
  if (next === '/reset-password') {
    return NextResponse.redirect(`${origin}/forgot-password?expired=1`)
  }
  return NextResponse.redirect(`${origin}/login?error=oauth`)
}
