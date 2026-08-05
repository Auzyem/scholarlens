'use client'
import { Suspense, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Logo } from '@/components/layout/Logo'

function ForgotPasswordForm() {
  // /auth/callback sends us here with ?expired=1 when a recovery link fails to
  // exchange — i.e. it has expired or was already used.
  const expired = useSearchParams().get('expired') === '1'
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true); setError(null)
    const supabase = createClient()
    // The recovery link lands on /auth/callback, which exchanges the code for a
    // session and forwards to /reset-password with that session in place.
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
    })
    setLoading(false)
    if (error) { setError(error.message); return }
    // Always report success: whether an address is registered is not something
    // this page should reveal.
    setSent(true)
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-4">
      <Logo size={32} />
      <Card className="w-full max-w-sm p-6">
        <h1 className="mb-4 text-xl font-semibold text-pr-navy">Reset your password</h1>
        {sent ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              If an account exists for <span className="font-medium">{email}</span>, we&apos;ve sent
              a link to set a new password. Check your inbox and your spam folder.
            </p>
            <Link href="/login" className="inline-block text-sm text-pr-teal underline">
              Back to log in
            </Link>
          </div>
        ) : (
          <>
            {expired && (
              <p className="mb-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                That reset link has expired or was already used. Request a new one below.
              </p>
            )}
            <p className="mb-4 text-sm text-muted-foreground">
              Enter your email and we&apos;ll send you a link to set a new password. This also works
              if you originally signed up with Google and have never had a password.
            </p>
            <form onSubmit={handleSubmit} className="space-y-3">
              <input className="w-full rounded border p-2" type="email" placeholder="Email"
                value={email} onChange={e => setEmail(e.target.value)} required />
              {error && <p className="text-sm text-red-600">{error}</p>}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? 'Sending…' : 'Send reset link'}
              </Button>
            </form>
            <p className="mt-4 text-sm text-muted-foreground">
              Remembered it? <Link href="/login" className="underline">Log in</Link>
            </p>
          </>
        )}
      </Card>
    </div>
  )
}

// useSearchParams opts the subtree into client-side rendering; without a
// Suspense boundary the production build fails to prerender this route.
export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ForgotPasswordForm />
    </Suspense>
  )
}
