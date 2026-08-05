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

  // /auth/callback has already exchanged the recovery code for a session by the
  // time we get here. Without one there is nothing to update.
  useEffect(() => {
    createClient().auth.getSession().then(({ data }) => setReady(!!data.session))
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
