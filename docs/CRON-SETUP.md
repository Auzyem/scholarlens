# Scheduling the stuck-review sweep

The sweep (`GET /api/cron/reap-reviews`) fails review sessions whose pipeline
died without writing a terminal status, releases the user's monthly quota, and
makes the review retryable. Design:
`docs/superpowers/specs/2026-07-31-stuck-review-reaper-design.md`.

It needs to run **every ~5 minutes**. The route re-checks the 10-minute
staleness threshold itself, so running late only delays cleanup — it can never
reap a live review — but running *rarely* undermines the point of the feature,
which is that a user is not left watching a spinner that never resolves.

## Why an external service

Two schedulers were tried first and both failed, for unrelated reasons:

| Scheduler | Outcome |
|---|---|
| **Vercel Cron** (`crons` in `vercel.json`) | The account is on the **Hobby** plan, which caps crons at once per **day**. Worse, a sub-daily entry makes *every deployment fail at creation* with no failed-deployment record — it silently blocked all deploys for hours before the cause was found. |
| **GitHub Actions** at `*/5` | Measured over its first four hours in production: **1 run instead of ~47.** GitHub aggressively throttles high-frequency schedules. |

What made both migrations cheap is that the endpoint authenticates on a **bearer
secret, not on caller identity** — so any scheduler holding `CRON_SECRET` is
equivalent, and swapping one for another needs no application code change.

Current arrangement:

- **Primary — an external cron service at ~5 minutes** (set up below).
- **Backstop — `.github/workflows/reap-stuck-reviews.yml`, hourly.** Free and
  independent, for when the external service is down or its account lapses.

Two schedulers is deliberate. The sweep is idempotent, guarded by a concurrency
group, and its updates are conditional on the row still being stuck, so a
duplicate run is harmless.

## What to configure

| Setting | Value |
|---|---|
| **URL** | `https://www.scholarlens.ac/api/cron/reap-reviews` |
| **Method** | `GET` |
| **Header** | `Authorization: Bearer <CRON_SECRET>` |
| **Schedule** | every 5 minutes (`*/5 * * * *`) |
| **Timeout** | ≥ 30s (the route allows itself 60s) |
| **Expected response** | `200` with `{"scanned":N,"reaped":[...]}` |

`<CRON_SECRET>` is the value already set in the Vercel **Production**
environment and in the repo's Actions secrets. All three must match.

### Hard requirement: custom request headers

The service **must** support setting a custom `Authorization` header. Do not use
a service that can only append a token to the query string, and do not add a
query-string fallback to the route: URLs end up in server logs, proxy logs and
referrers, which is not where a shared secret belongs.

Any of cron-job.org, Upstash QStash, EasyCron or Better Stack's monitors will do
this on a free tier; the specific choice does not matter.

### Alerting

Point the service's failure alert at the same inbox as Sentry. A sweep that
starts failing is itself a signal — a sustained `500` most likely means a schema
change broke the query, which is exactly the class of silent breakage that
motivated the monitoring work.

## Verifying it works

**Check the response**, not just that the job ran:

```bash
curl -sS -H "Authorization: Bearer $CRON_SECRET" \
  https://www.scholarlens.ac/api/cron/reap-reviews
# {"scanned":5,"reaped":[]}
```

| Response | Meaning |
|---|---|
| `200` + `{"scanned":N,"reaped":[]}` | Working, nothing stuck |
| `200` + non-empty `reaped` | Working, and it cleaned something up |
| `401` | The secret does not match the Vercel Production value |
| `500` | The query failed — check Sentry; likely a schema change |

**Confirm it is actually firing on schedule.** Both previous schedulers looked
configured and silently under-delivered, so check the service's run history
after an hour and count the runs. Expect ~12 per hour, not 1.

## Changing scheduler again

Everything is one config change, because nothing about the application depends
on who calls it:

- **Back to Vercel Cron** (needs Pro): restore the `crons` entry in
  `vercel.json`, and delete or keep this service.
- **To any other service**: same URL, method and header as above.
