'use client'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Check, CreditCard, ExternalLink, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

type Interval = 'monthly' | 'annual'

interface DbPlan {
  id: string
  name: string
  price_monthly_usd: number | null
  price_annual_monthly_usd: number | null
  annual_discount_pct: number | null
  max_manuscripts: number | null
  max_reviews_per_month: number | null
}

// Presentation-only metadata (copy + extra feature bullets). Prices, discounts,
// and manuscript/review limits come from the database so admins can edit them;
// this just describes each plan and lists bullets beyond those DB-driven counts.
const PLAN_META: Record<string, { description: string; extraFeatures: string[]; cta: string; highlight: boolean }> = {
  free: { description: 'Try the core review engine', highlight: false, cta: 'Current plan',
    extraFeatures: ['Score breakdown', 'Inline annotations'] },
  starter: { description: 'For active PhD students', highlight: false, cta: 'Upgrade to Starter',
    extraFeatures: ['Journal matching', 'PDF reports', 'Send to author'] },
  pro: { description: 'For serious researchers', highlight: true, cta: 'Upgrade to Pro',
    extraFeatures: ['Adversarial review', 'Journal matching', 'PDF reports'] },
  team: { description: 'For labs and departments', highlight: false, cta: 'Upgrade to Team',
    extraFeatures: ['All Pro features', 'Team members', 'Admin dashboard', 'API access'] },
}

export default function BillingPage() {
  const searchParams = useSearchParams()
  const [interval, setBillingInterval] = useState<Interval>('monthly')
  const [plans, setPlans] = useState<DbPlan[]>([])
  const [currentPlan, setCurrentPlan] = useState('free')
  const [periodEnd, setPeriodEnd] = useState<string | null>(null)
  const [cancelAtEnd, setCancelAtEnd] = useState(false)
  const [loading, setLoading] = useState<string | null>(null)
  const [managing, setManaging] = useState(false)
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  const success = searchParams.get('success')
  const canceled = searchParams.get('canceled')

  useEffect(() => {
    fetch('/api/billing/plans')
      .then(r => r.json())
      .then(({ plans: p }) => setPlans(p ?? []))
      .catch(() => setPlans([]))
  }, [])

  useEffect(() => {
    async function fetchCurrent() {
      const res = await fetch('/api/billing/current')
      const d = await res.json()
      setCurrentPlan(d.plan ?? 'free')
      setPeriodEnd(d.periodEnd ?? null)
      setCancelAtEnd(d.cancelAtEnd ?? false)
    }
    fetchCurrent()
    if (success) setToast({ type: 'success', message: 'Subscription activated — welcome!' })
    if (canceled) setToast({ type: 'error', message: 'Checkout canceled — no charge made.' })
  }, [success, canceled])

  async function handleUpgrade(planId: string) {
    if (planId === 'free' || planId === currentPlan) return
    setLoading(planId)
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId, interval }),
      })
      // Never call .json() on a potentially-empty body.
      const text = await res.text()
      let data: { url?: string; error?: string } = {}
      try { data = JSON.parse(text) } catch {
        throw new Error(`Server error (${res.status}): ${text.slice(0, 200) || 'Empty response'}`)
      }
      if (!res.ok) throw new Error(data.error ?? `Server error ${res.status}`)
      if (!data.url) throw new Error('No checkout URL returned')
      window.location.href = data.url
    } catch (e) {
      setToast({ type: 'error', message: e instanceof Error ? e.message : 'Checkout failed' })
      setLoading(null)
    }
  }

  async function handleManage() {
    setManaging(true)
    try {
      const res = await fetch('/api/billing/portal', { method: 'POST' })
      const text = await res.text()
      let data: { url?: string; error?: string } = {}
      try { data = JSON.parse(text) } catch {
        throw new Error(`Server error (${res.status})`)
      }
      if (!res.ok) throw new Error(data.error ?? 'Could not open portal')
      if (!data.url) throw new Error('No portal URL returned')
      window.location.href = data.url
    } catch (e) {
      setToast({ type: 'error', message: e instanceof Error ? e.message : 'Could not open portal' })
      setManaging(false)
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      {toast && (
        <div
          className={`mb-6 flex items-center justify-between rounded-md border px-4 py-2 text-sm ${
            toast.type === 'success'
              ? 'border-green-200 bg-green-50 text-green-800'
              : 'border-red-200 bg-red-50 text-red-800'
          }`}
        >
          {toast.message}
          <button onClick={() => setToast(null)} className="text-base leading-none">×</button>
        </div>
      )}

      <div className="mb-8">
        <h1 className="text-2xl font-semibold">Billing &amp; plans</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {currentPlan !== 'free'
            ? `You are on the ${currentPlan[0].toUpperCase() + currentPlan.slice(1)} plan${cancelAtEnd ? ' · Cancels at period end' : ''}${periodEnd ? ` · Renews ${new Date(periodEnd).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}`
            : 'You are on the Free plan.'}
        </p>
      </div>

      {currentPlan !== 'free' && (
        <Card className="mb-8 flex items-center gap-4 p-4">
          <CreditCard className="h-5 w-5 text-muted-foreground" />
          <div className="flex-1">
            <div className="text-sm font-medium">Manage your subscription</div>
            <div className="text-sm text-muted-foreground">Update payment method, download invoices, or cancel</div>
          </div>
          <Button onClick={handleManage} disabled={managing}>
            {managing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
            {managing ? 'Opening…' : 'Manage billing'}
          </Button>
        </Card>
      )}

      <div className="mb-6 flex items-center gap-3">
        <span className={`text-sm ${interval === 'monthly' ? 'font-medium' : 'text-muted-foreground'}`}>Monthly</span>
        <button
          onClick={() => setBillingInterval((i) => (i === 'monthly' ? 'annual' : 'monthly'))}
          className={`relative h-6 w-11 rounded-full transition-colors ${interval === 'annual' ? 'bg-pr-teal' : 'bg-muted'}`}
          aria-label="Toggle billing interval"
        >
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${interval === 'annual' ? 'left-[22px]' : 'left-0.5'}`} />
        </button>
        <span className={`text-sm ${interval === 'annual' ? 'font-medium' : 'text-muted-foreground'}`}>
          Annual <span className="ml-1 rounded-full bg-secondary px-2 py-0.5 text-xs">Up to 35% off</span>
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {plans.map((plan) => {
          // Team is an enterprise/academic licence assigned manually by an admin
          // after the customer contacts sales — never self-serve checkout.
          if (plan.id === 'team') {
            return (
              <Card key={plan.id} className="relative flex flex-col p-5">
                <div className="mb-3">
                  <div className="text-base font-medium">{plan.name}</div>
                  <div className="text-sm text-muted-foreground">For labs, departments, and institutions</div>
                </div>
                <ul className="mb-5 flex-1 space-y-2">
                  {['Bulk purchasing discounts', 'Department or campus-wide licences', 'Single invoice', 'Dedicated account management'].map((f) => (
                    <li key={f} className="flex items-start gap-2 text-sm">
                      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-pr-teal" /> {f}
                    </li>
                  ))}
                </ul>
                <Button asChild variant="outline" className="w-full">
                  <a href="mailto:contact@scholarlens.ac?subject=Team%20plan%20enquiry">Contact us</a>
                </Button>
              </Card>
            )
          }

          const meta = PLAN_META[plan.id] ?? { description: '', extraFeatures: [], cta: 'Upgrade', highlight: false }
          const isCurrent = plan.id === currentPlan
          const monthly = plan.price_monthly_usd ?? 0
          const annualMonthly = plan.price_annual_monthly_usd ?? 0
          const annualTotal = annualMonthly * 12
          const discount = plan.annual_discount_pct ?? 0
          const manuscripts = plan.max_manuscripts ?? 0
          const reviews = plan.max_reviews_per_month ?? 0
          const features = [
            `${manuscripts} manuscript${manuscripts === 1 ? '' : 's'}`,
            `${reviews} review${reviews === 1 ? '' : 's'} per month`,
            ...meta.extraFeatures,
          ]
          return (
            <Card key={plan.id} className={`relative flex flex-col p-5 ${meta.highlight ? 'border-2 border-pr-teal' : ''}`}>
              {meta.highlight && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-pr-teal px-3 py-0.5 text-xs font-medium text-white">
                  Most popular
                </div>
              )}
              <div className="mb-3">
                <div className="text-base font-medium">{plan.name}</div>
                <div className="text-sm text-muted-foreground">{meta.description}</div>
              </div>

              <div className="mb-4">
                {interval === 'monthly' ? (
                  <>
                    <span className="text-3xl font-semibold">${monthly}</span>
                    {monthly > 0 && <span className="text-sm text-muted-foreground">/mo</span>}
                  </>
                ) : (
                  <>
                    <span className="text-3xl font-semibold">${annualMonthly}</span>
                    <span className="text-sm text-muted-foreground">/mo</span>
                    {annualTotal > 0 && (
                      <div className="mt-1 text-[17px] font-bold tracking-tight text-pr-navy">
                        ${annualTotal.toFixed(2)}
                        <span className="text-xs font-normal text-muted-foreground"> billed annually</span>
                      </div>
                    )}
                    {discount > 0 && (
                      <div className="mt-1 inline-block rounded-full bg-pr-teal/10 px-2 py-0.5 text-[11px] font-medium text-pr-teal">
                        Save {discount}% vs monthly
                      </div>
                    )}
                  </>
                )}
              </div>

              <ul className="mb-5 flex-1 space-y-2">
                {features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm">
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-pr-teal" /> {f}
                  </li>
                ))}
              </ul>
              <Button
                onClick={() => handleUpgrade(plan.id)}
                disabled={isCurrent || loading === plan.id || plan.id === 'free'}
                variant={meta.highlight ? 'default' : 'outline'}
                className="w-full"
              >
                {loading === plan.id ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {isCurrent ? 'Current plan' : meta.cta}
              </Button>
            </Card>
          )
        })}
      </div>

      <p className="mt-6 text-center text-xs text-muted-foreground">
        All plans include core AI review, inline annotations, and XLSX export. Prices in USD. Cancel anytime from the billing portal.
      </p>
    </div>
  )
}
