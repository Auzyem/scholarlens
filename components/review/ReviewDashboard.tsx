'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { FieldConfirm } from './FieldConfirm'
import { PdfReportModal } from './PdfReportModal'
import { ReviewStages } from './ReviewStages'
import { VerticalSectionNav } from './VerticalSectionNav'
import { ReviewTopBar } from './ReviewTopBar'
import { OverviewSection } from './sections/OverviewSection'
import { AdversarialSection } from './sections/AdversarialSection'
import { JournalsSection } from './sections/JournalsSection'
import { ReportingSection } from './sections/ReportingSection'
import { ProgressSection } from './sections/ProgressSection'
import { reviewNumberFromSession } from '@/lib/review/sequence'
import type { SectionId } from '@/lib/review/sections'
import type { ReportingGuidelineId } from '@/lib/reporting/guidelines'
import type { ReviewSession, ReviewerPersona } from '@/lib/types'

const STEPS = ['routing', 'reviewing', 'complete'] as const

export function ReviewDashboard({ sessionId, manuscriptId }: { sessionId: string; manuscriptId: string }) {
  const [session, setSession] = useState<ReviewSession | null>(null)
  const [starting, setStarting] = useState(false)
  const [startingJournals, setStartingJournals] = useState(false)
  const [startingReporting, setStartingReporting] = useState(false)
  const [showPdf, setShowPdf] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)
  const [activeSection, setActiveSection] = useState<SectionId>('overview')
  const activeRef = useRef(true)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Mirrors `session` so the poll loop can decide whether to keep polling even
  // when a fetch throws (it has no fresh server value to read in that case).
  const sessionRef = useRef<ReviewSession | null>(null)

  const applySession = useCallback((s: ReviewSession | null) => {
    sessionRef.current = s
    setSession(s)
  }, [])

  const poll = useCallback(async () => {
    let next: ReviewSession | null = sessionRef.current
    try {
      const res = await fetch(`/api/review/status/${sessionId}`)
      const json = await res.json()
      if (!activeRef.current) return
      next = json.session as ReviewSession | null
      applySession(next)
    } catch {
      if (!activeRef.current) return
    }
    const mainPending = !!next && next.status !== 'complete' && next.status !== 'failed' && next.status !== 'awaiting_confirmation'
    const advRunning = !!next && next.adversarial_status === 'running'
    const jmRunning = !!next && next.journal_match_status === 'running'
    const rcRunning = !!next && next.reporting_check_status === 'running'
    if (mainPending || advRunning || jmRunning || rcRunning) {
      timerRef.current = setTimeout(poll, 3000)
    }
  }, [sessionId, applySession])

  useEffect(() => {
    activeRef.current = true
    poll()
    return () => {
      activeRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [poll])

  async function startAdversarial() {
    setStarting(true)
    applySession(sessionRef.current ? { ...sessionRef.current, adversarial_status: 'running' } : sessionRef.current)
    try {
      await fetch('/api/review/adversarial/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
    } catch {
      applySession(sessionRef.current ? { ...sessionRef.current, adversarial_status: 'not_started' } : sessionRef.current)
    } finally {
      setStarting(false)
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
      poll()
    }
  }

  async function startJournals() {
    setStartingJournals(true)
    applySession(sessionRef.current ? { ...sessionRef.current, journal_match_status: 'running' } : sessionRef.current)
    try {
      await fetch('/api/review/journals/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
    } catch {
      applySession(sessionRef.current ? { ...sessionRef.current, journal_match_status: 'not_started' } : sessionRef.current)
    } finally {
      setStartingJournals(false)
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
      poll()
    }
  }

  async function startReporting(guidelineId: ReportingGuidelineId) {
    setStartingReporting(true)
    applySession(sessionRef.current ? { ...sessionRef.current, reporting_check_status: 'running' } : sessionRef.current)
    try {
      await fetch('/api/review/reporting/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, guidelineId }),
      })
    } catch {
      applySession(sessionRef.current ? { ...sessionRef.current, reporting_check_status: 'not_started' } : sessionRef.current)
    } finally {
      setStartingReporting(false)
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
      poll()
    }
  }

  if (!session) return <p>Loading review…</p>

  if (session.status === 'failed') {
    return (
      <div className="space-y-3 rounded-lg border p-4">
        <p className="text-destructive">
          {session.error_message ?? 'The review failed.'}
        </p>
        {retryError && <p className="text-sm text-destructive">{retryError}</p>}
        <Button
          size="sm"
          disabled={retrying}
          onClick={async () => {
            setRetrying(true)
            setRetryError(null)
            try {
              const res = await fetch('/api/review/retry', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId }),
              })
              if (!res.ok) {
                const body = await res.json().catch(() => null)
                throw new Error(body?.error ?? `Retry failed (${res.status})`)
              }
              applySession({ ...session, status: 'queued', error_message: undefined })
              poll()
            } catch (e) {
              setRetryError(e instanceof Error ? e.message : 'Retry failed')
            } finally {
              setRetrying(false)
            }
          }}
        >
          {retrying ? 'Restarting…' : 'Retry review'}
        </Button>
      </div>
    )
  }

  if (session.status === 'awaiting_confirmation') {
    const manuscript = (session as unknown as {
      drafts?: { manuscripts?: { field?: string } }
    }).drafts?.manuscripts
    return (
      <FieldConfirm
        sessionId={sessionId}
        detectedField={manuscript?.field}
        detectedPersona={session.reviewer_persona as ReviewerPersona | undefined}
        confidence={session.routing_confidence}
        onConfirmed={() => {
          if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
          applySession({ ...session, status: 'reviewing' })
          poll()
        }}
      />
    )
  }

  if (session.status !== 'complete') {
    const idx = STEPS.indexOf(session.status as (typeof STEPS)[number])
    const pct = Math.max(5, Math.round(((idx + 1) / STEPS.length) * 100))
    return (
      <div className="max-w-md">
        <p className="mb-2 capitalize">Status: {session.status}…</p>
        <Progress value={pct} />
        <p className="mt-2 text-sm text-muted-foreground">Routing → Reviewing → Done</p>
      </div>
    )
  }

  const adv = session.adversarial_status ?? 'not_started'
  const jm = session.journal_match_status ?? 'not_started'
  const rc = session.reporting_check_status ?? 'not_started'
  const reviewNumber = reviewNumberFromSession(
    session as unknown as { drafts?: { version_number?: number } }
  )
  const manuscriptTitle = (session as unknown as {
    drafts?: { manuscripts?: { title?: string } }
  }).drafts?.manuscripts?.title ?? 'Review'

  return (
    <div className="flex flex-col gap-4 md:flex-row">
      <div className="shrink-0 space-y-4 md:w-52">
        <ReviewStages manuscriptId={manuscriptId} currentSessionId={sessionId} />
        <VerticalSectionNav active={activeSection} onSelect={setActiveSection} hasProgress={!!session.score_delta} />
      </div>

      <div className="min-w-0 flex-1 space-y-4">
        <ReviewTopBar
          reviewNumber={reviewNumber}
          verdict={session.verdict}
          score={session.overall_score ?? 0}
          sessionId={sessionId}
          manuscriptId={manuscriptId}
          onOpenPdf={() => setShowPdf(true)}
        />

        {activeSection === 'overview' && <OverviewSection session={session} />}
        {activeSection === 'adversarial' && (
          <AdversarialSection session={session} status={adv} starting={starting} onStart={startAdversarial} />
        )}
        {activeSection === 'journals' && (
          <JournalsSection session={session} status={jm} starting={startingJournals} onStart={startJournals} />
        )}
        {activeSection === 'reporting' && (
          <ReportingSection session={session} status={rc} starting={startingReporting} onStart={startReporting} />
        )}
        {activeSection === 'progress' && <ProgressSection session={session} />}
      </div>

      {showPdf && (
        <PdfReportModal sessionId={sessionId} manuscriptTitle={manuscriptTitle} onClose={() => setShowPdf(false)} />
      )}
    </div>
  )
}
