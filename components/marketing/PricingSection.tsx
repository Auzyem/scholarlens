'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Check } from 'lucide-react'

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

// Extra bullets beyond the manuscript/review counts, which come from the plan
// row itself so admin edits to those limits show up here without a code change.
const EXTRA_FEATURES: Record<string, string[]> = {
  free: ['Score breakdown', 'Inline annotations'],
  starter: ['PDF reports'],
  pro: ['Adversarial review'],
  team: [
    'Bulk purchasing discounts',
    'Department or campus-wide licences',
    'Single invoice',
    'Dedicated account management',
    'Custom onboarding for your users',
  ],
}
const HIGHLIGHT = 'pro'

export function PricingSection() {
  const [plans, setPlans] = useState<DbPlan[]>([])
  const [interval, setInterval] = useState<Interval>('monthly')

  useEffect(() => {
    fetch('/api/billing/plans')
      .then(r => r.json())
      .then(({ plans: p }) => setPlans(p ?? []))
      .catch(() => setPlans([]))
  }, [])

  return (
    <section id="pricing" className="border-t bg-pr-surface-alt">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <div className="text-center">
          <div className="text-xs font-semibold uppercase tracking-wide text-pr-teal">Pricing</div>
          <h2 className="mt-2 text-3xl font-bold text-pr-navy">Simple, transparent pricing</h2>
          <p className="mx-auto mt-2 max-w-2xl text-pr-body">
            Start free. Upgrade when you need more reviews, adversarial analysis, or team access.
          </p>

          {/* Interval toggle */}
          <div className="mt-6 inline-flex items-center gap-3 rounded-full border bg-white px-4 py-1.5">
            <span className={`text-sm ${interval === 'monthly' ? 'font-medium text-pr-navy' : 'text-pr-muted'}`}>Monthly</span>
            <button
              onClick={() => setInterval(i => (i === 'monthly' ? 'annual' : 'monthly'))}
              className={`relative h-6 w-11 rounded-full transition-colors ${interval === 'annual' ? 'bg-pr-teal' : 'bg-pr-line'}`}
              aria-label="Toggle billing interval"
            >
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${interval === 'annual' ? 'left-[22px]' : 'left-0.5'}`} />
            </button>
            <span className={`text-sm ${interval === 'annual' ? 'font-medium text-pr-navy' : 'text-pr-muted'}`}>
              Annual <span className="ml-1 rounded-full bg-pr-teal-tint px-2 py-0.5 text-xs text-pr-teal-700">Save up to 35%</span>
            </span>
          </div>
        </div>

        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {plans.map(plan => {
            if (plan.id === 'team') {
              return (
                <div key={plan.id} className="relative flex flex-col rounded-xl border bg-white p-6">
                  <div className="text-base font-semibold text-pr-navy">Academic &amp; Enterprise Licence</div>
                  <p className="mt-3 text-sm text-pr-body">
                    Designed for universities, colleges, training providers and organisations
                    looking to provide access for multiple users.
                  </p>
                  <ul className="mt-4 mb-6 flex-1 space-y-2">
                    {EXTRA_FEATURES.team.map(f => (
                      <li key={f} className="flex items-start gap-2 text-sm text-pr-body">
                        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-pr-teal" /> {f}
                      </li>
                    ))}
                  </ul>
                  <a
                    href="#contact"
                    className="w-full rounded-md border px-4 py-2 text-center text-sm font-medium text-pr-body hover:bg-pr-surface-alt"
                  >
                    Contact us
                  </a>
                </div>
              )
            }

            const monthly = plan.price_monthly_usd ?? 0
            const annualMonthly = plan.price_annual_monthly_usd ?? 0
            const annualTotal = annualMonthly * 12
            const discount = plan.annual_discount_pct ?? 0
            const highlight = plan.id === HIGHLIGHT
            const manuscripts = plan.max_manuscripts ?? 0
            const reviews = plan.max_reviews_per_month ?? 0
            const features = [
              `${manuscripts} manuscript${manuscripts === 1 ? '' : 's'}`,
              `${reviews} review${reviews === 1 ? '' : 's'} / month`,
              ...(EXTRA_FEATURES[plan.id] ?? []),
            ]
            return (
              <div key={plan.id} className={`relative flex flex-col rounded-xl border bg-white p-6 ${highlight ? 'border-2 border-pr-teal shadow-md' : ''}`}>
                {highlight && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-pr-teal px-3 py-0.5 text-xs font-medium text-white">
                    Most popular
                  </div>
                )}
                <div className="text-base font-semibold text-pr-navy">{plan.name}</div>
                <div className="mt-3">
                  {interval === 'monthly' ? (
                    <>
                      <span className="text-3xl font-bold text-pr-navy">${monthly}</span>
                      {monthly > 0 && <span className="text-sm text-pr-muted">/mo</span>}
                    </>
                  ) : (
                    <>
                      <span className="text-3xl font-bold text-pr-navy">${annualMonthly}</span>
                      <span className="text-sm text-pr-muted">/mo</span>
                      {annualTotal > 0 && (
                        <div className="mt-1 text-[17px] font-bold tracking-tight text-pr-navy">
                          ${annualTotal.toFixed(2)}
                          <span className="text-xs font-normal text-pr-muted"> billed annually</span>
                        </div>
                      )}
                      {discount > 0 && (
                        <div className="mt-1 inline-block rounded-full bg-pr-teal-tint px-2 py-0.5 text-[11px] font-medium text-pr-teal-700">
                          Save {discount}% vs monthly
                        </div>
                      )}
                    </>
                  )}
                </div>
                <ul className="mt-4 mb-6 flex-1 space-y-2">
                  {features.map(f => (
                    <li key={f} className="flex items-start gap-2 text-sm text-pr-body">
                      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-pr-teal" /> {f}
                    </li>
                  ))}
                </ul>
                <Link
                  href="/signup"
                  className={`w-full rounded-md px-4 py-2 text-center text-sm font-medium ${highlight ? 'bg-pr-teal text-white hover:bg-pr-teal-600' : 'border text-pr-body hover:bg-pr-surface-alt'}`}
                >
                  {plan.id === 'free' ? 'Get started free' : `Choose ${plan.name}`}
                </Link>
              </div>
            )
          })}
        </div>

        <p className="mt-6 text-center text-xs text-pr-muted">
          All plans include core AI review and XLSX export. Prices in USD. Cancel anytime.
        </p>
      </div>
    </section>
  )
}
