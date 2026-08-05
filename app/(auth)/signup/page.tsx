'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { GoogleButton } from '@/components/auth/GoogleButton'
import { Logo } from '@/components/layout/Logo'

export default function SignupPage() {
  const router = useRouter()
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [checkEmail, setCheckEmail] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true); setError(null); setNotice(null)
    const supabase = createClient()
    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: {
        data: { full_name: fullName },
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    })
    setLoading(false)
    if (error) { setError(error.message); return }

    // Supabase does not error when the address already exists — it returns an
    // obfuscated success with an empty identities array, sets no password, and
    // sends no email. Treating that as a real signup is what left users unable
    // to log in with a password they believed they had just chosen.
    if (data.user && (data.user.identities?.length ?? 0) === 0) {
      setNotice(
        'An account already exists for this email. Log in below, continue with Google, or reset your password if you have forgotten it.'
      )
      return
    }

    // Email confirmation is on, so there is no session yet. Pushing to
    // /dashboard here just gets bounced back to /login by the middleware.
    if (!data.session) { setCheckEmail(true); return }

    router.push('/dashboard')
    router.refresh()
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-4">
      <Logo size={32} />
      <Card className="w-full max-w-sm p-6">
        <h1 className="mb-4 text-xl font-semibold text-pr-navy">Create your account</h1>
        {checkEmail ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Check your email — we&apos;ve sent a confirmation link to{' '}
              <span className="font-medium">{email}</span>. Once you&apos;ve confirmed, you can log
              in with your email and password.
            </p>
            <Link href="/login" className="inline-block text-sm text-pr-teal underline">
              Go to log in
            </Link>
          </div>
        ) : (
          <>
            <form onSubmit={handleSignup} className="space-y-3">
              <input className="w-full rounded border p-2" placeholder="Full name"
                value={fullName} onChange={e => setFullName(e.target.value)} />
              <input className="w-full rounded border p-2" type="email" placeholder="Email"
                value={email} onChange={e => setEmail(e.target.value)} required />
              <input className="w-full rounded border p-2" type="password" placeholder="Password"
                value={password} onChange={e => setPassword(e.target.value)} required />
              {notice && (
                <div className="rounded border border-amber-300 bg-amber-50 p-2.5 text-sm text-amber-800">
                  {notice}{' '}
                  <Link href="/forgot-password" className="font-medium underline">Reset password</Link>
                </div>
              )}
              {error && <p className="text-sm text-red-600">{error}</p>}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? 'Creating…' : 'Sign up'}
              </Button>
            </form>
            <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
            </div>
            <GoogleButton label="Sign up with Google" />
            <p className="mt-4 text-sm text-muted-foreground">
              Have an account? <Link href="/login" className="underline">Log in</Link>
            </p>
          </>
        )}
      </Card>
    </div>
  )
}
