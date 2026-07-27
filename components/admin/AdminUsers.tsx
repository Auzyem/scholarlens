'use client'
import { useState, useEffect, useCallback } from 'react'
import { Search, Trash2, Loader2 } from 'lucide-react'

interface AdminUser {
  id: string
  email: string
  full_name?: string
  institution?: string
  created_at: string
  subscriptions?: { plan_id?: string; status?: string } | { plan_id?: string; status?: string }[] | null
  user_roles?: { role: string }[] | null
}

const ROLES = ['author', 'reviewer', 'admin', 'super_admin']
const PLANS = ['free', 'starter', 'pro', 'team']

function planOf(u: AdminUser): string {
  const sub = Array.isArray(u.subscriptions) ? u.subscriptions[0] : u.subscriptions
  return sub?.plan_id ?? 'free'
}
function roleOf(u: AdminUser): string {
  return u.user_roles?.[0]?.role ?? 'author'
}
function initials(name?: string, email?: string): string {
  const src = name?.trim() || email || '?'
  const parts = src.split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || src[0].toUpperCase()
}

export function AdminUsers() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [role, setRole] = useState('')
  const [plan, setPlan] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const fetchUsers = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({ q, role, plan })
    const res = await fetch(`/api/admin/users?${params}`)
    const data = await res.json()
    setUsers(data.users ?? [])
    setLoading(false)
  }, [q, role, plan])

  useEffect(() => { fetchUsers() }, [fetchUsers])

  const changeRole = async (userId: string, newRole: string) => {
    setPending(userId)
    try {
      const res = await fetch(`/api/admin/users/${userId}/role`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      })
      const text = await res.text()
      let data: { error?: string } = {}
      try { data = JSON.parse(text) } catch { throw new Error(`Server error (${res.status})`) }
      if (!res.ok) throw new Error(data.error ?? 'Failed to change role')
      setToast('Role updated')
      await fetchUsers()
    } catch (e) {
      setToast(`Error: ${e instanceof Error ? e.message : 'Failed'}`)
    } finally {
      setPending(null)
    }
  }

  const changePlan = async (userId: string, newPlan: string) => {
    setPending(userId)
    try {
      const res = await fetch(`/api/admin/users/${userId}/plan`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: newPlan }),
      })
      const text = await res.text()
      let data: { error?: string } = {}
      try { data = JSON.parse(text) } catch { throw new Error(`Server error (${res.status})`) }
      if (!res.ok) throw new Error(data.error ?? 'Failed to change plan')
      setToast(newPlan === 'team' ? 'Team plan granted' : 'Plan updated')
      await fetchUsers()
    } catch (e) {
      setToast(`Error: ${e instanceof Error ? e.message : 'Failed'}`)
    } finally {
      setPending(null)
    }
  }

  const deleteUser = async (userId: string, email: string) => {
    if (!confirm(`Permanently delete ${email}? This cannot be undone.`)) return
    setPending(userId)
    try {
      const res = await fetch(`/api/admin/users/${userId}`, { method: 'DELETE' })
      const text = await res.text()
      let data: { error?: string } = {}
      try { data = JSON.parse(text) } catch { throw new Error(`Server error (${res.status})`) }
      if (!res.ok) throw new Error(data.error ?? 'Failed to delete user')
      setToast('User deleted')
      await fetchUsers()
    } catch (e) {
      setToast(`Error: ${e instanceof Error ? e.message : 'Failed'}`)
    } finally {
      setPending(null)
    }
  }

  return (
    <div>
      {toast && (
        <div className="mb-4 rounded-md bg-pr-teal/10 px-4 py-2.5 text-sm text-pr-teal">
          {toast}
          <button onClick={() => setToast(null)} className="ml-2">×</button>
        </div>
      )}

      <div className="mb-4 flex flex-wrap gap-2.5">
        <div className="relative min-w-[200px] flex-1">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search by email…" className="h-9 w-full rounded-md border bg-background pl-8 pr-3 text-sm" />
        </div>
        <select value={role} onChange={e => setRole(e.target.value)} className="h-9 rounded-md border bg-background px-2.5 text-sm">
          <option value="">All roles</option>
          {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
        <select value={plan} onChange={e => setPlan(e.target.value)} className="h-9 rounded-md border bg-background px-2.5 text-sm">
          <option value="">All plans</option>
          {PLANS.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>

      {loading ? (
        <div className="py-10 text-center text-sm text-muted-foreground">Loading users…</div>
      ) : users.length === 0 ? (
        <div className="py-10 text-center text-sm text-muted-foreground">No users match.</div>
      ) : (
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-3 font-medium">User</th>
                <th className="p-3 font-medium">Institution</th>
                <th className="p-3 font-medium">Plan</th>
                <th className="p-3 font-medium">Role</th>
                <th className="p-3 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} className="border-t">
                  <td className="p-3">
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-7 w-7 items-center justify-center rounded-full bg-pr-teal text-[11px] font-medium text-white">
                        {initials(u.full_name, u.email)}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate font-medium">{u.full_name ?? '—'}</div>
                        <div className="truncate text-xs text-muted-foreground">{u.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="p-3 text-muted-foreground">{u.institution ?? '—'}</td>
                  <td className="p-3">
                    <select
                      value={planOf(u)}
                      disabled={pending === u.id}
                      onChange={e => changePlan(u.id, e.target.value)}
                      className="h-8 rounded-md border bg-background px-2 text-xs"
                      title="Assign plan (Team is a manual enterprise grant, not billed via Stripe)"
                    >
                      {PLANS.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </td>
                  <td className="p-3">
                    <select
                      value={roleOf(u)}
                      disabled={pending === u.id}
                      onChange={e => changeRole(u.id, e.target.value)}
                      className="h-8 rounded-md border bg-background px-2 text-xs"
                    >
                      {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </td>
                  <td className="p-3 text-right">
                    <button
                      onClick={() => deleteUser(u.id, u.email)}
                      disabled={pending === u.id}
                      className="rounded p-1.5 text-red-600 hover:bg-red-50"
                      title="Delete user"
                    >
                      {pending === u.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
