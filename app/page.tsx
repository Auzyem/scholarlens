import Link from 'next/link'
import {
  Upload, Compass, ShieldAlert, Library, FileSpreadsheet, TrendingUp,
  ArrowRight, Mail, Check,
} from 'lucide-react'
import { ScoreRadar } from '@/components/review/ScoreRadar'
import { PricingSection } from '@/components/marketing/PricingSection'
import { Logo } from '@/components/layout/Logo'
import type { Score } from '@/lib/types'

const DEMO_SCORES: Score[] = [
  { id: '1', session_id: 'd', dimension: 'originality', score: 8, max_score: 10 },
  { id: '2', session_id: 'd', dimension: 'significance', score: 7, max_score: 10 },
  { id: '3', session_id: 'd', dimension: 'methodology', score: 6, max_score: 10 },
  { id: '4', session_id: 'd', dimension: 'evidence_quality', score: 7, max_score: 10 },
  { id: '5', session_id: 'd', dimension: 'literature_engagement', score: 8, max_score: 10 },
  { id: '6', session_id: 'd', dimension: 'internal_logic', score: 6, max_score: 10 },
  { id: '7', session_id: 'd', dimension: 'presentation_clarity', score: 9, max_score: 10 },
  { id: '8', session_id: 'd', dimension: 'ethical_compliance', score: 8, max_score: 10 },
]

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
      {/* Nav */}
      <header className="sticky top-0 z-10 border-b bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Logo size={26} />
          <nav className="hidden items-center gap-6 text-sm text-pr-body sm:flex">
            <a href="#how" className="hover:text-pr-navy">How it works</a>
            <a href="#features" className="hover:text-pr-navy">Features</a>
            <a href="#pricing" className="hover:text-pr-navy">Pricing</a>
            <a href="#contact" className="hover:text-pr-navy">Contact</a>
          </nav>
          <div className="flex items-center gap-3 text-sm">
            <Link href="/login" className="text-pr-body hover:text-pr-navy">Log in</Link>
            <Link href="/signup" className="rounded-md bg-pr-teal px-3 py-1.5 font-medium text-white hover:bg-pr-teal-600">
              Sign up
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute -top-24 right-0 h-96 w-96 rounded-full bg-pr-teal/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 -left-24 h-96 w-96 rounded-full bg-pr-teal-tint/40 blur-3xl" />
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-20 md:grid-cols-2">
          <div>
            <h1 className="text-4xl font-bold leading-tight sm:text-5xl">
              See what you might have missed
            </h1>
            <p className="mt-4 text-lg text-pr-body">
              Upload your thesis, dissertation, capstone or research paper and receive structured
              academic feedback to help strengthen your work before submission.
              <br />
              Comprehensive Review • Actionable Feedback • Submit with Confidence
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href="/login"
                className="inline-flex items-center gap-2 rounded-md bg-pr-teal px-5 py-3 font-medium text-white shadow hover:bg-pr-teal-600"
              >
                Get started <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/signup"
                className="inline-flex items-center gap-2 rounded-md border px-5 py-3 font-medium text-pr-body hover:bg-pr-surface-alt"
              >
                Create an account
              </Link>
            </div>
            <p className="mt-4 text-sm text-pr-muted">No credit card required · PDF &amp; DOCX supported</p>
          </div>

          {/* Hero visual: a product-style card using the real radar chart */}
          <div className="rounded-2xl border bg-white p-6 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <span className="rounded-full bg-pr-gold-light px-3 py-1 text-xs font-semibold text-pr-gold">
                Minor revision
              </span>
              <span className="text-lg font-semibold text-pr-navy">59 / 80</span>
            </div>
            <ScoreRadar scores={DEMO_SCORES} />
            <p className="mt-2 text-center text-xs text-pr-muted">
              Eight quality dimensions, scored 1–10
            </p>
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

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-6 py-8 text-sm text-pr-muted sm:flex-row">
          <span>© {new Date().getFullYear()} ScholarLens</span>
          <div className="flex gap-4">
            <Link href="/login" className="hover:text-pr-navy">Log in</Link>
            <Link href="/signup" className="hover:text-pr-navy">Sign up</Link>
            <a href="mailto:contact@scholarlens.ac" className="hover:text-pr-navy">Contact</a>
          </div>
        </div>
      </footer>
    </main>
  )
}
