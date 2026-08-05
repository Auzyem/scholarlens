// Diagnostic: which auth providers/identities exist per user, and are they confirmed?
// Reads .env.local explicitly so OS-level env vars cannot shadow it.
import fs from 'node:fs'

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]
    })
)

const url = env.NEXT_PUBLIC_SUPABASE_URL
const key = env.SUPABASE_SERVICE_ROLE_KEY
console.log('project:', url)

const res = await fetch(`${url}/auth/v1/admin/users?per_page=200`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` },
})
if (!res.ok) {
  console.error('failed:', res.status, await res.text())
  process.exit(1)
}
const { users } = await res.json()
console.log(`users: ${users.length}\n`)
for (const listed of users) {
  const detail = await fetch(`${url}/auth/v1/admin/users/${listed.id}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  }).then((r) => r.json())
  const identities = (detail.identities ?? []).map((i) => i.provider)
  console.log(
    [
      detail.email,
      `identities=[${identities.join(',') || 'NONE'}]`,
      `app_meta.providers=${JSON.stringify(detail.app_metadata?.providers ?? detail.app_metadata?.provider ?? null)}`,
      `confirmed=${detail.email_confirmed_at ? 'yes' : 'NO'}`,
      `last_sign_in=${detail.last_sign_in_at ?? 'never'}`,
    ].join('  ')
  )
}
