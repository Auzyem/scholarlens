import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { createClient } from '@/lib/supabase/server'
import { runJournalMatchPipeline } from '@/lib/ai/journalMatchPipeline'
import { checkFeatureGate } from '@/lib/plan/gates'

export const maxDuration = 300

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const gate = await checkFeatureGate(user.id, 'journal_matching')
  if (!gate.allowed) {
    return NextResponse.json(
      { error: 'Journal matching requires a Pro plan or above', upgradeUrl: '/billing' },
      { status: 403 }
    )
  }

  const { sessionId } = await request.json()
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })

  // RLS: this select only returns the row if the session belongs to the user.
  const { data: session, error } = await supabase
    .from('review_sessions')
    .select('id, status, journal_match_status')
    .eq('id', sessionId)
    .single()

  if (error || !session) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (session.status !== 'complete') {
    return NextResponse.json({ error: 'Standard review is not complete yet' }, { status: 409 })
  }
  if (session.journal_match_status === 'running' || session.journal_match_status === 'complete') {
    return NextResponse.json(
      { error: 'Journal matching already running or complete' },
      { status: 409 }
    )
  }

  // Run detached from the response lifecycle. The promise starts immediately;
  // waitUntil keeps the function alive on Vercel. Outside the Vercel runtime
  // (e.g. `next dev`), waitUntil can throw — swallow it.
  const pipeline = runJournalMatchPipeline(sessionId)
  pipeline.catch((e) => console.error('[journal match pipeline] failed:', e))
  try {
    waitUntil(pipeline)
  } catch {
    // Non-Vercel runtime: the floating promise above continues on its own.
  }

  return NextResponse.json({ ok: true })
}
