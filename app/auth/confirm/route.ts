import { NextRequest, NextResponse } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'

// Separate from /auth/callback because Supabase hands us two different token
// shapes and they are not interchangeable. Our own links produce a PKCE grant
// (`?code=…`, redeemed with exchangeCodeForSession); Supabase's current default
// email templates use `{{ .TokenHash }}` and produce `?token_hash=…&type=…`,
// which only verifyOtp can redeem. One route guessing which it was handed would
// just be two routes wearing a trench coat.
//
// The landing is the whole reason this exists: a recovery or invite sent from
// the Supabase dashboard carries no `next`, so anything that defaults to
// /dashboard leaves the user signed in and still without a password — the exact
// thing the email was supposed to give them.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null
  const next = searchParams.get('next')

  // Both mean "this account has no password the user knows": recovery because
  // they forgot it, invite because one was never set.
  const needsPassword = type === 'recovery' || type === 'invite'

  if (tokenHash && type) {
    const supabase = createClient()
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash })
    if (!error) {
      const destination = next ?? (needsPassword ? '/reset-password' : '/dashboard')
      return NextResponse.redirect(`${origin}${destination}`)
    }
  }

  // A dead recovery or invite link has exactly one useful next step, and it is
  // not /login — someone who has no password cannot log in to fix anything.
  if (needsPassword) {
    return NextResponse.redirect(`${origin}/forgot-password?expired=1`)
  }
  return NextResponse.redirect(`${origin}/login?error=link`)
}
