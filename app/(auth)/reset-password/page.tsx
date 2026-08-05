'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Logo } from '@/components/layout/Logo'

export default function ResetPasswordPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [ready, setReady] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // The session reaches us three ways. /auth/callback and /auth/confirm put it
  // in cookies before this page renders, so getSession() sees it immediately.
  // The implicit hash flow does not: RecoveryRedirect establishes it in the
  // browser, and that can still be settling when we mount. A lone early
  // getSession() would therefore call a perfectly good link expired, so we also
  // listen for the auth event and only give up after a short grace period.
  useEffect(() => {
    const supabase = createClient()
    let gone = false
    let hasSession = false
    let timer: ReturnType<typeof setTimeout> | undefined

    // "Ready" is final; "expired" never is. A session arriving late should flip
    // the page back to the form, because showing it a beat late costs nothing
    // and a false "expired" costs the user a working link.
    function markReady() {
      if (gone || hasSession) return
      hasSession = true
      if (timer) clearTimeout(timer)
      setReady(true)
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (session && (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN')) markReady()
    })

    supabase.auth.getSession().then(({ data }) => {
      if (gone) return
      if (data.session) { markReady(); return }
      // Nothing in storage yet. Give the client-side flow a moment to land one
      // before calling the link dead — but do call it, so this never just hangs.
      timer = setTimeout(() => { if (!gone && !hasSession) setReady(false) }, 1500)
    })

    return () => {
      gone = true
      subscription.unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (password !== confirm) { setError('Passwords do not match'); return }
    if (password.length < 8) { setError('Password must be at least 8 characters'); return }
    setLoading(true); setError(null)
    // On an account that only had a Google identity, this creates the email
    // identity — which is what makes password login work for the first time.
    const { error } = await createClient().auth.updateUser({ password })
    setLoading(false)
    if (error) { setError(error.message); return }
    router.replace('/dashboard')
    router.refresh()
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-4">
      <Logo size={32} />
      <Card className="w-full max-w-sm p-6">
        <h1 className="mb-4 text-xl font-semibold text-pr-navy">Set a new password</h1>
        {ready === false ? (
          <div className="space-y-3">
            <p className="text-sm text-red-600">
              This reset link is invalid or has expired.
            </p>
            <Link href="/forgot-password" className="inline-block text-sm text-pr-teal underline">
              Request a new one
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <input className="w-full rounded border p-2" type="password" placeholder="New password"
              value={password} onChange={e => setPassword(e.target.value)} required />
            <input className="w-full rounded border p-2" type="password" placeholder="Confirm new password"
              value={confirm} onChange={e => setConfirm(e.target.value)} required />
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading || ready === null}>
              {loading ? 'Saving…' : 'Set password'}
            </Button>
          </form>
        )}
      </Card>
    </div>
  )
}
