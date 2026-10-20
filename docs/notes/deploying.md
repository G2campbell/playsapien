> Copied from the claude.ai "PlaySapien" project on 20 Oct 2026 for the move to Claude Code.
> Dated notes: where this disagrees with CLAUDE.md, CLAUDE.md wins.

# Deploying PlaySapien, and the Safe Browsing flag

Last updated 15 September 2026.

## Status

**playsapien.com is live.** The shell, both games and the legal pages are all
serving from the repo. Two things remain: the API Worker (`/api/*` is 404, so
accounts and friends do not work yet — the games run their offline path) and the
Google Safe Browsing flag, which still shows visitors a red interstitial.

| Route | State |
|---|---|
| `/` `/about/` `/privacy/` `/terms/` | live |
| `/sdk.js` `/tokens.css` `/theme.js` `/legal.css` | live |
| `/wordchain/` | live, renders, correct palette |
| `/sojourner/` | live, globes render |
| `/sojourner` `/wordchain` (no slash) | redirect correctly |
| `/api/*` | **404 — not deployed** |

---

## 1. The Safe Browsing flag — still open

### Why it is there

Certificate Transparency logs show certificates for `playsapien.com` and
`*.playsapien.com` issued in June and August 2025 — Sectigo DV and Google Trust
Services, all expiring by 31 October 2025, then nothing. Somebody ran a site on
this name through late 2025, it lapsed, and the name dropped and was
re-registered. Safe Browsing reputation attaches to the **domain**, so the new
owner inherits the verdict.

The interstitial is the red "Dangerous site" page reading *"Attackers on the site
you tried visiting might trick you into installing software or revealing things
like your passwords, phone, or credit card numbers"* — the **social engineering**
classification, not malware.

**Do not trust the Transparency Report to check this.** It returns "No available
data" for this domain while Chrome is actively showing the interstitial. The
interstitial is the truth.

### How to clear it

1. ✅ Real site deployed — done.
2. **Google Search Console** → add `playsapien.com` as a **Domain** property.
   Verification is a DNS TXT record; Cloudflare hosts the DNS, so it is quick.
3. **Security & Manual Actions → Security Issues.** The only place that shows the
   specific reason and sample URLs. Read it before requesting anything.
4. **Request Review.** State that the domain was recently acquired, give the
   registration date, and say the site was rebuilt from scratch with nothing from
   the previous owner remaining. Reviewers handle this case routinely.
5. Typical turnaround for social engineering is 1–3 days.
6. Separately, report the URL as safe to **Microsoft SmartScreen** at
   `microsoft.com/en-us/wdsi/filesubmission/` — they keep their own list.

If it comes back still flagged, get the specific evidence from Search Console
before re-requesting. Blind re-requests do not help. If the domain proves
persistently burned, changing the name is cheaper before any brand is built on it.

---

## 2. The architecture: one game, one Worker

Each surface is its own Cloudflare Worker, divided by URL path:

| Path | Repo folder | Worker | Bound by |
|---|---|---|---|
| `playsapien.com/` | `apps/shell` | `playsapien` | custom domain |
| `playsapien.com/wordchain/*` | `games/wordchain` | `playsapien-wordchain` | route |
| `playsapien.com/sojourner/*` | `games/sojourner` | `playsapien-sojourner` | route |
| `playsapien.com/api/*` | `backend` | `playsapien-api` | route (not yet) |

**Why this works:** Cloudflare treats a Worker on a custom domain as the *origin*,
and Workers on routes are evaluated **before** it. Each game's route intercepts its
own paths; everything else falls through to the shell. Adding a game means adding a
Worker and a route, and touching nothing that exists. This deletes the router
Worker the README planned — routes do that job.

Consequences of the split: each surface owns its own `_headers`/`_redirects`, read
from the root of its own assets (so `deploy/assemble.sh` is now only for the local
preview), and assets are staged one level deep (`cfroot/<game>/...`) because the
URL path is what Cloudflare looks up inside the assets directory.

### Deploying a game

The shell rebuilds automatically from GitHub. The two games were created with the
Wrangler CLI, because the dashboard's create-a-Worker wizard would not advance past
repository selection. To deploy a game:

    cd games/<game>
    sh build.sh          # REQUIRED — cfroot/ is a build output, not in the repo
    npx wrangler deploy

Forgetting `build.sh` gives:

    ✘ [ERROR] The directory specified by the "assets.directory" field
      in your configuration file does not exist: ...\games\wordchain\cfroot

To make a game rebuild automatically like the shell, connect its Worker to Git and
set Build command `sh build.sh`, Deploy command `npx wrangler deploy`, Root
directory `games/<game>`, Include paths `games/<game>/**, packages/**`. Include
paths are what stop a push to one game from rebuilding the others.

### Build settings that matter

- `.python-version` must pin an **exact** version Cloudflare already has (`3.13.3`).
  Writing `3.13` makes it resolve to the newest 3.13 and download it — that cost
  3m 20s of a 3m 52s build.

---

## 3. Line endings — a real hazard here, not a style question

`.gitattributes` pins everything to LF. This is not cosmetic. Git on Windows
checks out CRLF by default, which turns `set -eu` into `set -eu\r`, and every
`build.sh` dies with:

    build.sh: 3: set: Illegal option -

It also makes `git status` report every file as modified — at one point 127 files,
96,385 insertions and 96,385 deletions, all phantom.

**Never keep a git repo inside OneDrive.** OneDrive writes `desktop.ini` files into
`.git/`, including `.git/refs/`, which produced `fatal: bad object refs/desktop.ini`.
The working copy now lives at `C:\Users\G2Campbell\playsapien-live`, outside
OneDrive. GitHub is the backup; OneDrive does not need to be.

---

## 4. Verify after deploy

    curl -I https://playsapien.com/sojourner    # 301 to /sojourner/
    curl -I https://playsapien.com/wordchain    # 301
    curl -s  https://playsapien.com/tokens.css | head -1
    curl -sI https://playsapien.com/api/auth/session   # 401 signed out, not 404

A 404 on `/sdk.js` or `/tokens.css` means the shell's `build.sh` regressed — it
copies those from `deploy/`, and an earlier `assemble.sh` silently did not. A 404
rather than 401 on `/api/*` means the API Worker's route is not bound.
