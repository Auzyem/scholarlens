import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import type { CareerStage, Profile } from '@/lib/types'
import { UserStatsPanel } from '@/components/stats/UserStatsPanel'

const CAREER_STAGES: { value: CareerStage; label: string }[] = [
  { value: 'phd_student', label: 'PhD student' },
  { value: 'postdoc', label: 'Postdoc' },
  { value: 'junior_faculty', label: 'Junior faculty' },
  { value: 'senior_faculty', label: 'Senior faculty' },
  { value: 'independent', label: 'Independent researcher' },
]
const STAGE_VALUES = CAREER_STAGES.map(s => s.value)

async function saveProfile(formData: FormData) {
  'use server'
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const str = (k: string) => {
    const v = (formData.get(k) as string | null)?.trim()
    return v ? v : null
  }
  const careerStage = str('career_stage')
  const update = {
    full_name: str('full_name'),
    institution: str('institution'),
    discipline: str('discipline'),
    native_language: str('native_language'),
    career_stage: careerStage && STAGE_VALUES.includes(careerStage as CareerStage) ? careerStage : null,
  }

  await supabase.from('profiles').update(update).eq('id', user.id)
  revalidatePath('/settings')
}

export default async function SettingsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single()
  const profile = (data ?? {}) as Partial<Profile>

  return (
    <div className="max-w-xl">
      <h1 className="mb-4 text-2xl font-semibold">Settings</h1>

      <form action={saveProfile} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium">Email</label>
          <input
            value={profile.email ?? user.email ?? ''}
            disabled
            className="w-full rounded-md border bg-muted px-3 py-2 text-muted-foreground"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Full name</label>
          <input name="full_name" defaultValue={profile.full_name ?? ''} className="w-full rounded-md border px-3 py-2" />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Institution</label>
          <input name="institution" defaultValue={profile.institution ?? ''} className="w-full rounded-md border px-3 py-2" />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Discipline</label>
          <input name="discipline" defaultValue={profile.discipline ?? ''} className="w-full rounded-md border px-3 py-2" placeholder="e.g. Environmental Science" />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Career stage</label>
          <p className="mb-1 text-xs text-muted-foreground">Used to tailor journal recommendations.</p>
          <select name="career_stage" defaultValue={profile.career_stage ?? ''} className="w-full rounded-md border bg-background px-3 py-2">
            <option value="">Prefer not to say</option>
            {CAREER_STAGES.map(s => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Native language</label>
          <input name="native_language" defaultValue={profile.native_language ?? ''} className="w-full rounded-md border px-3 py-2" placeholder="e.g. English" />
        </div>

        <button type="submit" className="rounded-md bg-primary px-4 py-2 text-primary-foreground">
          Save changes
        </button>
      </form>

      <div className="mt-10">
        <h2 className="mb-4 text-lg font-semibold">Your activity</h2>
        <UserStatsPanel />
      </div>
    </div>
  )
}
