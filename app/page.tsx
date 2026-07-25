import Link from 'next/link'
import { Space_Grotesk, Public_Sans } from 'next/font/google'
import {
  Upload, Compass, ShieldAlert, Library, FileSpreadsheet, TrendingUp,
  ArrowRight, Mail, Check,
} from 'lucide-react'
import { PricingSection } from '@/components/marketing/PricingSection'
import { Logo } from '@/components/layout/Logo'
import { MarketingHeader } from '@/components/layout/MarketingHeader'
import { MarketingFooter } from '@/components/layout/MarketingFooter'

const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], weight: ['500', '600', '700'] })
const publicSans = Public_Sans({ subsets: ['latin'], weight: ['400', '500', '600', '700'] })

const HERO_PILLS = ['Comprehensive review', 'Actionable feedback', 'Submit with confidence']

const STEPS = [
  { icon: Upload, title: 'Upload your manuscript', body: 'Drop in a PDF or DOCX. ScholarLens analyses your full manuscript, structure, arguments and key sections.' },
  { icon: Compass, title: 'Match your research context', body: 'Your manuscript is assessed against your discipline, research area and the expectations of relevant reviewers.' },
  { icon: ShieldAlert, title: 'Stress-test your paper', body: 'Receive a rigorous reviewer-style assessment across eight dimensions, including an optional "Reviewer 2" challenge to uncover weaknesses before submission.' },
  { icon: Library, title: 'Find the right journal fit', body: 'Explore ranked journal recommendations with scope alignment and publication insights. Understand what changes could improve alignment before submission.' },
]

const FEATURES = [
  { icon: Check, title: 'Eight dimensions of research quality', body: 'Originality, significance, methodology, evidence, literature, logic, clarity and ethics - each scored with reviewer rationale and actionable improvements.' },
  { icon: ShieldAlert, title: 'Reviewer 2 stress test', body: 'Simulate the toughest reviewer objections, with quoted passages, explanations and clear actions to strengthen your manuscript.' },
  { icon: Library, title: 'Journal matching', body: 'Five to eight venues ranked by fit, with impact factor, decision time, open-access options, and APC.' },
  { icon: TrendingUp, title: 'Track your revisions', body: 'Upload revised drafts and see which scores improved, which reviewer concerns were resolved and where further work is needed.' },
  { icon: FileSpreadsheet, title: 'Export your review plan', body: 'Export a structured reviewer-response matrix containing scores, annotations, critiques and journal targets across four organised sheets.' },
  { icon: Compass, title: 'Designed for researchers at every stage', body: 'Designed for PhD candidates and early-career researchers preparing manuscripts for academic journal submission.' },
]

export default function Home() {
  return (
    <main className="min-h-screen bg-white text-pr-navy">
      <MarketingHeader />

      {/* Hero */}
      <section className={`relative overflow-hidden bg-gradient-to-br from-white via-[#F3F9FA] to-pr-teal-tint ${publicSans.className}`}>
        <div className="pointer-events-none absolute -top-24 right-0 h-96 w-96 rounded-full bg-pr-teal/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 -left-24 h-96 w-96 rounded-full bg-pr-teal-tint/60 blur-3xl" />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-70"
          style={{
            backgroundImage:
              'linear-gradient(rgba(7,17,47,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(7,17,47,0.035) 1px, transparent 1px)',
            backgroundSize: '64px 64px',
            maskImage: 'radial-gradient(ellipse 90% 70% at 55% 40%, #000, transparent)',
            WebkitMaskImage: 'radial-gradient(ellipse 90% 70% at 55% 40%, #000, transparent)',
          }}
        />
        <div className="relative mx-auto grid max-w-6xl items-center gap-16 px-6 py-16 lg:grid-cols-2 lg:py-24">
          <div className="text-center lg:text-left">
            <h1
              className={`text-[44px] font-semibold leading-[1.05] tracking-tight text-pr-navy lg:text-[66px] ${spaceGrotesk.className}`}
            >
              See what you might have{' '}
              <span className="relative inline-block text-pr-teal">
                <span className="absolute inset-x-0 bottom-1.5 -z-10 h-2.5 rounded bg-pr-teal/20" />
                missed
              </span>
            </h1>
            <p className="mx-auto mt-6 max-w-[52ch] text-lg leading-relaxed text-pr-body lg:mx-0">
              Upload your thesis, dissertation, capstone or research paper and receive structured
              academic feedback to help strengthen your work before submission.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2.5 lg:justify-start">
              {HERO_PILLS.map(pill => (
                <span
                  key={pill}
                  className="inline-flex items-center gap-2 rounded-full border bg-white px-4 py-2 text-sm font-medium text-pr-navy shadow-sm"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-pr-teal" /> {pill}
                </span>
              ))}
            </div>
            <div className="mt-9 flex flex-wrap justify-center gap-3.5 lg:justify-start">
              <Link
                href="/login"
                className="inline-flex items-center gap-2 rounded-xl bg-pr-teal px-8 py-4 font-semibold text-white shadow-[0_10px_30px_rgba(23,162,184,0.32)] hover:bg-pr-teal-600"
              >
                Get started <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/signup"
                className="inline-flex items-center gap-2 rounded-xl border px-8 py-4 font-semibold text-pr-navy hover:bg-pr-surface-alt"
              >
                Create an account
              </Link>
            </div>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-4 text-sm text-pr-muted lg:justify-start">
              <span className="inline-flex items-center gap-1.5">
                <Check className="h-3.5 w-3.5 text-pr-teal" /> No credit card required
              </span>
              <span className="h-1 w-1 rounded-full bg-pr-line" />
              <span className="inline-flex items-center gap-1.5">
                <Check className="h-3.5 w-3.5 text-pr-teal" /> PDF &amp; DOCX supported
              </span>
            </div>
          </div>

          {/* Brand mark panel */}
          <div className="relative flex flex-col items-center justify-center gap-8 text-center">
            <div className="pointer-events-none absolute h-[380px] w-[380px] rounded-full bg-pr-teal/20 blur-3xl" />
            <div className="relative flex h-[260px] w-[260px] items-center justify-center rounded-full border border-pr-teal/25 sm:h-[340px] sm:w-[340px]">
              <div className="absolute inset-9 rounded-full border border-pr-teal/20 sm:inset-11" />
              <div className="absolute inset-[68px] rounded-full bg-white shadow-[0_24px_60px_rgba(7,17,47,0.10)] sm:inset-[88px]" />
              <Logo size={72} className="relative" />
            </div>
            <div className="flex items-center justify-center gap-3 text-[11px] font-semibold uppercase tracking-[0.24em] text-pr-muted">
              <span>Clarity</span>
              <span className="h-1 w-1 rounded-full bg-pr-teal" />
              <span>Insight</span>
              <span className="h-1 w-1 rounded-full bg-pr-teal" />
              <span>Confidence</span>
            </div>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="border-t bg-pr-surface-alt">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <h2 className="text-center text-3xl font-bold text-pr-navy">How it works</h2>
          <p className="mx-auto mt-2 max-w-2xl text-center text-pr-body">
            ScholarLens analyses your manuscript across multiple review dimensions, highlights
            weaknesses and helps you identify the right journals to target.
          </p>
          <ol className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s, i) => (
              <li key={s.title} className="rounded-xl border bg-white p-6 shadow-sm">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-pr-teal-tint text-pr-teal-700">
                  <s.icon className="h-5 w-5" />
                </div>
                <div className="mt-4 text-xs font-semibold text-pr-teal">Step {i + 1}</div>
                <h3 className="mt-1 font-semibold text-pr-navy">{s.title}</h3>
                <p className="mt-1 text-sm text-pr-body">{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Pricing */}
      <PricingSection />

      {/* Features */}
      <section id="features" className="mx-auto max-w-6xl px-6 py-20">
        <h2 className="text-center text-3xl font-bold text-pr-navy">Your complete pre-submission review</h2>
        <p className="mx-auto mt-2 max-w-2xl text-center text-pr-body">
          Understand how reviewers may judge your manuscript before it reaches a journal.
        </p>
        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(f => (
            <div key={f.title} className="rounded-xl border p-6">
              <f.icon className="h-6 w-6 text-pr-teal" />
              <h3 className="mt-3 font-semibold text-pr-navy">{f.title}</h3>
              <p className="mt-1 text-sm text-pr-body">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Contact / CTA */}
      <section id="contact" className="border-t bg-pr-navy text-white">
        <div className="mx-auto max-w-6xl px-6 py-20 text-center">
          <h2 className="text-3xl font-bold">Ready to strengthen your next submission?</h2>
          <p className="mx-auto mt-3 max-w-2xl text-white/60">
            Create a free account and run your first review today. Questions, feedback, or
            institutional access? We&rsquo;d love to hear from you.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/signup"
              className="inline-flex items-center gap-2 rounded-md bg-pr-teal px-5 py-3 font-medium text-white hover:bg-pr-teal-600"
            >
              Get started free <ArrowRight className="h-4 w-4" />
            </Link>
            <a
              href="mailto:contact@scholarlens.ac"
              className="inline-flex items-center gap-2 rounded-md border border-white/30 px-5 py-3 font-medium text-white hover:bg-white/10"
            >
              <Mail className="h-4 w-4" /> Contact us
            </a>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </main>
  )
}
