import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { checkManuscriptLimit } from '@/lib/plan/gates'

const SORTABLE = new Set(['updated_at', 'created_at', 'title', 'word_count'])

export async function GET(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { searchParams } = new URL(request.url)
    const q      = searchParams.get('q') ?? ''
    const field  = searchParams.get('field') ?? ''
    const status = searchParams.get('status') ?? 'active'   // 'active' | 'archived' | 'all'
    const sortBy = searchParams.get('sort') ?? 'updated_at'
    const order  = searchParams.get('order') ?? 'desc'
    const sortColumn = SORTABLE.has(sortBy) ? sortBy : 'updated_at'

    let query = supabase
      .from('manuscripts')
      .select('*, drafts(id, version_number, review_sessions(id, status, overall_score, verdict))')
      .eq('user_id', user.id)

    if (status === 'active')   query = query.eq('archived', false)
    if (status === 'archived') query = query.eq('archived', true)
    if (q)     query = query.ilike('title', `%${q}%`)
    if (field) query = query.eq('field', field)

    const { data, error } = await query.order(sortColumn, { ascending: order === 'asc' })
    if (error) throw error
    return NextResponse.json({ manuscripts: data })
  } catch (error: unknown) {
    console.error('[api/manuscripts GET] error:', error)
    const message = error instanceof Error ? error.message : 'Failed to load manuscripts'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { title, submission_target } = body
  if (!title) return NextResponse.json({ error: 'Title required' }, { status: 400 })

  const limit = await checkManuscriptLimit(user.id)
  if (!limit.allowed) {
    const planName = limit.plan[0].toUpperCase() + limit.plan.slice(1)
    return NextResponse.json(
      { error: `Manuscript limit reached (${limit.used}/${limit.limit} on the ${planName} plan)`, upgradeUrl: '/billing' },
      { status: 403 }
    )
  }

  const { data, error } = await supabase
    .from('manuscripts')
    .insert({ user_id: user.id, title, submission_target })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ manuscript: data })
}
