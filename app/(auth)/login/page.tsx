'use client'
import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { GoogleButton } from '@/components/auth/GoogleButton'
import { Logo } from '@/components/layout/Logo'

/**
 * Isolated so that `useSearchParams` opts ONLY this banner out of server
 * rendering. It used to sit inside the form component, which put the entire
 * login page inside the Suspense boundary — with `fallback={null}` that shipped
 * an empty page and no form at all until JavaScript hydrated. The login form is
 * the last thing in the app that should depend on client-side rendering.
 *
 * /auth/callback redirects here with ?error=oauth when the code exchange fails.
 * Left unrendered it looked like the Google button simply did nothing.
 */
function OAuthErrorBanner() {
  if (useSearchParams().get('error') !== 'oauth') return null
  return (
    <p className="mb-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      Sign-in with Google didn&apos;t complete. Please try again.
    </p>
  )
}

function LoginForm() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true); setError(null)
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setLoading(false)
    if (error) {
      // "Invalid login credentials" is also what Supabase returns when the
      // account has no password at all — the case for anyone who signed up
      // with Google. Naming both recovery routes turns a dead end into a fix.
      setError(
        error.message === 'Invalid login credentials'
          ? 'We couldn’t sign you in. If you signed up with Google, use "Continue with Google" below — or reset your password to set one.'
          : error.message === 'Email not confirmed'
            ? 'Please confirm your email first — check your inbox for the link we sent.'
            : error.message
      )
      return
    }
    // replace (not push) so the login page is not left in history, and refresh
    // so the middleware re-reads the freshly-set session cookie.
    router.replace('/dashboard')
    router.refresh()
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-4">
      <Logo size={32} />
      <Card className="w-full max-w-sm p-6">
        <h1 className="mb-4 text-xl font-semibold text-pr-navy">Log in</h1>
        <Suspense fallback={null}>
          <OAuthErrorBanner />
        </Suspense>
        <form onSubmit={handleLogin} className="space-y-3">
          <input className="w-full rounded border p-2" type="email" placeholder="Email"
            value={email} onChange={e => setEmail(e.target.value)} required />
          <input className="w-full rounded border p-2" type="password" placeholder="Password"
            value={password} onChange={e => setPassword(e.target.value)} required />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Logging in…' : 'Log in'}
          </Button>
          <div className="text-right">
            <Link href="/forgot-password" className="text-xs text-muted-foreground underline hover:text-foreground">
              Forgot password?
            </Link>
          </div>
        </form>
        <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
        </div>
        <GoogleButton />
        <p className="mt-4 text-sm text-muted-foreground">
          No account? <Link href="/signup" className="underline">Sign up</Link>
        </p>
      </Card>
    </div>
  )
}

// The Suspense boundary lives around OAuthErrorBanner rather than out here, so
// the form itself still server-renders. Wrapping the whole page satisfies the
// build the same way, but ships a blank card.
export default function LoginPage() {
  return <LoginForm />
}
