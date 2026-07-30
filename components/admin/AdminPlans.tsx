'use client'
import { useState, useEffect } from 'react'
import { Save, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { API_KEY_SCOPES } from '@/lib/types'

interface Plan {
  id: string
  name: string
  price_monthly_usd?: number
  price_annual_monthly_usd?: number
  annual_discount_pct?: number
  max_manuscripts?: number
  max_reviews_per_month?: number
  adversarial_access?: boolean
  journal_matching?: boolean
  pdf_reports?: boolean
  api_access?: boolean
  max_api_keys?: number
  allowed_scopes?: string[]
  [key: string]: unknown
}

export function AdminPlans() {
  const [plans, setPlans] = useState<Plan[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [edits, setEdits] = useState<Record<string, Plan>>({})
  const [toast, setToast] = useState<string | null>(null)
  const [reconciling, setReconciling] = useState(false)
  const [confirm, setConfirm] = useState<{
    planId: string
    name: string
    changes: { interval: 'monthly' | 'annual'; usd: number }[]
  } | null>(null)

  useEffect(() => {
    fetch('/api/admin/plans')
      .then(r => r.json())
      .then(({ plans: p }) => {
        const list: Plan[] = p ?? []
        setPlans(list)
        const init: Record<string, Plan> = {}
        list.forEach(pl => { init[pl.id] = { ...pl } })
        setEdits(init)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const change = (planId: string, field: string, value: unknown) => {
    setEdits(prev => ({ ...prev, [planId]: { ...prev[planId], [field]: value } }))
  }

  // Re-read live subscriptions from Stripe and make the database agree. The
  // remedy when a customer paid but stayed on their old plan (missed webhook).
  const reconcile = async () => {
    setReconciling(true)
    try {
      const res = await fetch('/api/admin/billing/reconcile', { method: 'POST' })
      const text = await res.text()
      let data: { scanned?: number; syncedCount?: number; skipped?: number; error?: string } = {}
      try { data = JSON.parse(text) } catch { throw new Error(`Server error (${res.status})`) }
      if (!res.ok) throw new Error(data.error ?? `Server error ${res.status}`)
      setToast(
        `Reconciled ${data.syncedCount ?? 0} of ${data.scanned ?? 0} live Stripe subscription(s)` +
        (data.skipped ? ` — ${data.skipped} could not be matched to a user` : ''),
      )
    } catch (e) {
      setToast(`Error: ${e instanceof Error ? e.message : 'Reconcile failed'}`)
    }
    setReconciling(false)
  }

  // Which price fields differ from the loaded original?
  const priceChanges = (planId: string): { interval: 'monthly' | 'annual'; usd: number }[] => {
    const orig = plans.find(p => p.id === planId)
    const next = edits[planId]
    if (!orig || !next) return []
    const out: { interval: 'monthly' | 'annual'; usd: number }[] = []
    if (next.price_monthly_usd != null && next.price_monthly_usd !== orig.price_monthly_usd) {
      out.push({ interval: 'monthly', usd: Number(next.price_monthly_usd) })
    }
    if (next.price_annual_monthly_usd != null && next.price_annual_monthly_usd !== orig.price_annual_monthly_usd) {
      out.push({ interval: 'annual', usd: Number(next.price_annual_monthly_usd) })
    }
    return out
  }

  // PATCH non-price fields only (sync-price owns the price columns to avoid drift).
  const patchNonPriceFields = async (planId: string) => {
    const updates = { ...edits[planId] }
    delete updates.price_monthly_usd
    delete updates.price_annual_monthly_usd
    const res = await fetch('/api/admin/plans', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId, updates }),
    })
    const text = await res.text()
    let data: { error?: string } = {}
    try { data = JSON.parse(text) } catch { throw new Error(`Server error (${res.status})`) }
    if (!res.ok) throw new Error(data.error ?? 'Update failed')
  }

  const save = async (planId: string) => {
    const changes = priceChanges(planId)
    // Paid plan with a changed price → confirm before any Stripe write.
    if (planId !== 'free' && changes.length > 0) {
      setConfirm({ planId, name: edits[planId]?.name ?? planId, changes })
      return
    }
    // Otherwise just PATCH (non-price fields; free plan never syncs).
    setSaving(planId)
    try {
      await patchNonPriceFields(planId)
      setPlans(prev => prev.map(p => (p.id === planId ? { ...p, ...edits[planId] } : p)))
      setToast(`${edits[planId]?.name ?? planId} plan updated`)
    } catch (e) {
      setToast(`Error: ${e instanceof Error ? e.message : 'Update failed'}`)
    }
    setSaving(null)
  }

  // Runs after the admin confirms the dialog: sync each changed interval, then PATCH.
  const runSync = async () => {
    if (!confirm) return
    const snapshot = confirm
    setSaving(snapshot.planId)
    setConfirm(null)
    try {
      for (const c of snapshot.changes) {
        const res = await fetch('/api/admin/plans/sync-price', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planId: snapshot.planId, interval: c.interval, unitAmountUsd: c.usd }),
        })
        const text = await res.text()
        let data: { error?: string } = {}
        try { data = JSON.parse(text) } catch { throw new Error(`Server error (${res.status})`) }
        if (!res.ok) throw new Error(data.error ?? 'Price sync failed')
      }
      await patchNonPriceFields(snapshot.planId)
      setPlans(prev => prev.map(p => (p.id === snapshot.planId ? { ...p, ...edits[snapshot.planId] } : p)))
      setToast(`${snapshot.name} plan price synced to Stripe`)
    } catch (e) {
      setToast(`Error: ${e instanceof Error ? e.message : 'Price sync failed'}`)
    }
    setSaving(null)
  }

  const numField = (planId: string, field: keyof Plan, label: string, suffix = '') => (
    <div className="mb-2.5">
      <label className="mb-1 block text-xs text-muted-foreground">{label}</label>
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          value={(edits[planId]?.[field] as number | undefined) ?? ''}
          onChange={e => change(planId, field as string, e.target.value === '' ? null : Number(e.target.value))}
          className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
        />
        {suffix && <span className="whitespace-nowrap text-xs text-muted-foreground">{suffix}</span>}
      </div>
    </div>
  )

  const textField = (planId: string, field: keyof Plan, label: string) => (
    <div className="mb-2.5">
      <label className="mb-1 block text-xs text-muted-foreground">{label}</label>
      <input
        type="text"
        value={(edits[planId]?.[field] as string | undefined) ?? ''}
        onChange={e => change(planId, field as string, e.target.value)}
        className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
      />
    </div>
  )

  const boolField = (planId: string, field: keyof Plan, label: string) => (
    <label className="mb-2 flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={!!edits[planId]?.[field]}
        onChange={e => change(planId, field as string, e.target.checked)}
        className="h-3.5 w-3.5"
      />
      {label}
    </label>
  )

  const scopeSelector = (planId: string) => {
    const current = (edits[planId]?.allowed_scopes ?? []) as string[]
    return (
      <div className="mb-2.5">
        <label className="mb-1.5 block text-xs text-muted-foreground">Allowed API scopes</label>
        <div className="flex flex-wrap gap-x-3 gap-y-1.5">
          {Object.keys(API_KEY_SCOPES).map(scope => {
            const checked = current.includes(scope)
            return (
              <label key={scope} className="flex cursor-pointer items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={e =>
                    change(
                      planId,
                      'allowed_scopes',
                      e.target.checked ? [...current, scope] : current.filter(s => s !== scope)
                    )
                  }
                  className="h-3 w-3"
                />
                <code className="font-mono text-xs">{scope}</code>
              </label>
            )
          })}
        </div>
      </div>
    )
  }

  if (loading) return <div className="py-10 text-center text-sm text-muted-foreground">Loading plans…</div>

  return (
    <div>
      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <Card className="w-full max-w-md p-5">
            <div className="mb-2 text-sm font-medium text-pr-navy">Confirm price change</div>
            <p className="mb-3 text-sm text-muted-foreground">
              This will create {confirm.changes.length > 1 ? 'new live Stripe prices' : 'a new live Stripe price'} for the{' '}
              <span className="font-medium text-foreground">{confirm.name}</span> plan:
            </p>
            <ul className="mb-3 space-y-1 text-sm">
              {confirm.changes.map(c => (
                <li key={c.interval}>
                  • ${c.usd}/mo{c.interval === 'annual' ? ' (billed annually)' : ''}
                </li>
              ))}
            </ul>
            <p className="mb-4 text-xs text-muted-foreground">
              New customers will be charged the new amount. Existing subscribers keep their current price.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setConfirm(null)}>Cancel</Button>
              <Button size="sm" onClick={runSync}>Create price &amp; save</Button>
            </div>
          </Card>
        </div>
      )}
      {toast && (
        <div className="mb-4 rounded-md bg-pr-teal/10 px-4 py-2.5 text-sm text-pr-teal">
          {toast}
          <button onClick={() => setToast(null)} className="ml-2">×</button>
        </div>
      )}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border px-4 py-3">
        <div className="text-sm text-muted-foreground">
          Subscription sync — re-reads live Stripe subscriptions and corrects any user left on the
          wrong plan (e.g. after a missed webhook).
        </div>
        <Button variant="outline" size="sm" onClick={reconcile} disabled={reconciling}>
          {reconciling ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          Reconcile with Stripe
        </Button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {plans.map(plan => (
          <Card key={plan.id} className="p-4">
            <div className="mb-3 text-sm font-medium text-pr-navy">{plan.name} plan</div>
            {textField(plan.id, 'name', 'Plan name')}
            {numField(plan.id, 'price_monthly_usd', 'Monthly price (USD)', '$/mo')}
            {numField(plan.id, 'price_annual_monthly_usd', 'Annual price per month (USD)', '$/mo')}
            {numField(plan.id, 'annual_discount_pct', 'Annual discount (%)', '%')}
            {numField(plan.id, 'max_manuscripts', 'Max manuscripts')}
            {numField(plan.id, 'max_reviews_per_month', 'Max reviews/month')}
            <div className="mb-3 mt-3 border-t pt-3">
              {boolField(plan.id, 'adversarial_access', 'Adversarial review')}
              {boolField(plan.id, 'journal_matching', 'Journal matching')}
              {boolField(plan.id, 'pdf_reports', 'PDF reports')}
              {boolField(plan.id, 'api_access', 'API access')}
            </div>
            <div className="mb-3 border-t pt-3">
              {numField(plan.id, 'max_api_keys', 'Max API keys (-1 = unlimited)')}
              {scopeSelector(plan.id)}
            </div>
            <Button onClick={() => save(plan.id)} disabled={saving === plan.id || confirm?.planId === plan.id} className="w-full" size="sm">
              {saving === plan.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save changes
            </Button>
          </Card>
        ))}
      </div>
    </div>
  )
}
