> Copied from the claude.ai "PlaySapien" project on 20 Oct 2026 for the move to Claude Code.
> Dated notes: where this disagrees with CLAUDE.md, CLAUDE.md wins.

# The API Worker — deployed 15 September 2026

`playsapien.com/api/*` is live. Stage 1 of 3 is done: the Worker runs, the D1
database is bound and queried, sessions and auth guards work. What remains is
the two outside services that make sign-in actually usable.

## Verified live

| Probe | Result | What it proves |
|---|---|---|
| `GET /api/health` | `200 {"ok":true,"data":{"status":"ok"}}` | Worker is running |
| `GET /api/auth/session` | `200 {"user":null,"today":"2026-09-15"}` | Session check works; UTC day key correct |
| `GET /api/nonexistent` | `404` JSON envelope | Route binding works — this is the Worker's own 404, not the shell's HTML one |
| `POST /api/auth/email/start` (bad address) | `400 invalid_email` | Request reaches real handler code |
| `GET /api/wordchain/bank/2026-09-15` | `404 "No chain is scheduled for that day."` | **D1 binding works** — a semantic 404 means the query ran and returned no row. A broken binding gives 500 |
| `GET /api/player/me` | `401 "Sign in to do that."` | Auth guard works |
| `GET /api/admin/queue` | `503 admin_unconfigured` | Fail-closed admin, working as designed |

Note `/api/auth/session` returns **200 with `user: null`** for a signed-out
visitor, not 401. That is correct: asking who you are is not an error.

## Config decisions made

- **Route added to `backend/wrangler.toml`.** It had none. Without it the Worker
  deploys but nothing reaches it — requests fall through to the shell Worker on
  the custom domain and come back 404. A route is matched *before* a
  custom-domain Worker, which is what lets the API and site share one hostname.
- **`binding = "DB"` must stay as-is.** `wrangler d1 create` prints a suggested
  block whose binding matches the *database name* (`playsapien`). `src/` reads
  `env.DB` in seven places. Pasting the printed block wholesale breaks every
  query. A comment in the file now warns about this.
- `database_id = "a9e94d32-d795-445f-a1aa-b52dc927fee6"` — not a secret; it only
  identifies which database. Access comes from the binding.
- Secrets set: `LOGIN_CODE_PEPPER`, `OAUTH_STATE_SECRET` (both random, generated
  on the user's machine, never transmitted).

## Still to do

**Stage 2 — Resend**, so the six-digit sign-in codes send as email. Without
`RESEND_API_KEY` the Worker logs the code to the console and still reports
`{sent: true}` — fine for development, useless in production. Needs a resend.com
account, DNS records added in Cloudflare as **DNS only** (grey cloud — mail
records must not be proxied), and `MAIL_FROM` at the verified domain.

**Stage 3 — Google OAuth.** Needs a Google Cloud project, consent screen with
`openid` + `userinfo.email` + `userinfo.profile` (none need review), and an OAuth
client whose redirect URI matches exactly. `GOOGLE_CLIENT_ID` goes in
`wrangler.toml` (it ships in the redirect URL, so not a secret);
`GOOGLE_CLIENT_SECRET` is a secret.

**Admin surface** is deliberately closed until `ACCESS_TEAM_DOMAIN` and
`ACCESS_AUD` are both set from a Cloudflare Access application.

**The Word Chain bank is empty.** `/api/wordchain/bank/<day>` has no rows, so no
chain is scheduled server-side for any day. The game currently works without it.
Worth understanding before relying on server-supplied chains.

## Redeploying

    cd backend
    npx wrangler deploy

Not connected to Git — unlike the shell, this deploys manually. Same trade-off as
the games.
