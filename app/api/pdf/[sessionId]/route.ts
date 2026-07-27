import type React from 'react'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { renderToBuffer } from '@react-pdf/renderer'
import { Template1PDFDocument } from '@/lib/pdf/Template1Report'
import { Template2PDFDocument } from '@/lib/pdf/Template2Report'
import { createElement } from 'react'
import { format } from 'date-fns'
import { checkFeatureGate } from '@/lib/plan/gates'

export const maxDuration = 60

export async function GET(
  _request: NextRequest,
  { params }: { params: { sessionId: string } }
) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const gate = await checkFeatureGate(user.id, 'pdf_reports')
    if (!gate.allowed) {
      return NextResponse.json(
        { error: 'PDF reports require a Starter plan or above', upgradeUrl: '/billing' },
        { status: 403 }
      )
    }

    // RLS scopes the row to the owner. Select mirrors the status + export routes
    // (keep all review relations consistent across the select sites).
    const { data: session, error } = await supabase
      .from('review_sessions')
      .select(`
        *,
        scores(*),
        annotations(*),
        adversarial_critiques(*),
        journal_matches(*),
        reporting_checklist_items(*),
        drafts(version_number, manuscripts(title, abstract, field, doc_type))
      `)
      .eq('id', params.sessionId)
      .single()

    if (error || !session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const generatedAt = format(new Date(), 'dd MMMM yyyy')
    const versionNumber = (session.drafts as { version_number?: number } | null)?.version_number ?? 1
    // A re-review either is a v2+ draft or carries a comparison link.
    const isReReview = versionNumber > 1 || Boolean(session.compared_to_session_id)

    let element: React.ReactElement
    if (!isReReview) {
      element = createElement(Template1PDFDocument, {
        session: session as never,
        generatedAt,
      })
    } else {
      let priorSession: unknown = undefined
      if (session.compared_to_session_id) {
        const { data: prior } = await supabase
          .from('review_sessions')
          .select('verdict, created_at, scores(*)')
          .eq('id', session.compared_to_session_id)
          .single()
        priorSession = prior ?? undefined
      }
      element = createElement(Template2PDFDocument, {
        session: session as never,
        priorSession: priorSession as never,
        generatedAt,
      })
    }

    const buffer = await renderToBuffer(
      element as unknown as React.ReactElement<{ title?: string; author?: string }>
    )

    const safeId = params.sessionId.replace(/[^a-zA-Z0-9-]/g, '')
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="scholarlens-review-${safeId}.pdf"`,
      },
    })
  } catch (error: unknown) {
    console.error('[api/pdf] error:', error)
    const message = error instanceof Error ? error.message : 'Failed to generate PDF'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
