# Security model

Nexara CLI is designed to be public source code.

## What is safe to publish

- The Supabase URL
- The Supabase publishable/anon key
- The deployed Nexara app URL
- Model names, aliases, and client-side defaults

Publishable keys are restricted by Supabase Row Level Security and are not
service credentials.

## What must never be published

- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENROUTER_API_KEY` and any model-gateway/provider API-key list the web
  server reads from its own environment (never name, commit, or publish those
  gateway keys)
- `COMPOSIO_API_KEY`
- `E2B_API_KEY`
- PayPal, Discord, search-provider, or other server-side secrets
- `.env` files, refresh tokens, or a user's `~/.nexara/config.json`

The CLI authenticates a user with Supabase and sends chat requests to the Nexara
web API. The web server selects the model, applies quotas and credits, and calls
OpenRouter-class routers using server-side environment variables. The CLI never needs
the provider API keys and should not be changed to call those providers directly.

## How conversation data is isolated (Supabase RLS)

Saved threads and messages live in Supabase and are read both by the Nexara web
app and by this CLI — the CLI connects with the publishable/anon key under the
signed-in user's own session, never with the service-role key. Isolation is
therefore enforced by Supabase Row Level Security, whose rules are defined in the
web app's version-controlled migrations (`Nexera/supabase/migrations/`):

- `threads` and `messages` have RLS enabled, and the baseline policy for each is
  owner-only: `USING (auth.uid() = user_id)` for both reads and writes.
- The only additional access is opt-in and narrowly scoped: read-only access to
  threads a user explicitly marked public (share links), and read/write access
  to a thread whose owner invited them as a collaborator (`thread_collaborators`
  rows). No migration drops, disables, or widens the owner-only baseline.
- A user cannot list, read, or write another user's threads or messages through
  the Supabase API by guessing ids — every query is filtered by the same RLS.
- The CLI further restricts its own thread lists to conversations it started
  (`origin = 'cli'`); chat requests themselves always go through the Nexara web
  API so server-side quotas and billing apply.

If you self-host and want to audit the live policies, the canonical check is:

```sql
select schemaname, tablename, policyname, cmd, roles
from pg_policies
where tablename in ('threads', 'messages', 'thread_collaborators')
order by tablename, cmd;
```

For a self-hosted deployment, set these public client values at runtime rather
than committing them:

```powershell
$env:NEXARA_APP_URL = "https://your-deployment.example"
$env:NEXARA_SUPABASE_URL = "https://your-project.supabase.co"
$env:NEXARA_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_..."
```

If a secret is accidentally exposed, revoke it immediately, rotate it in the
provider dashboard, remove it from Git history, and check the deployment logs.

## Update security

The CLI can update itself from the GitHub main branch. Because a self-update
installs the newest published source, an attacker who gains write access to the
repository could push a malicious CLI that would then be auto-installed. Treat
the repo as a supply-chain root:

- Restrict write access to trusted humans only; require reviews on every change.
- Protect the `main` branch (no direct pushes, reviews required).
- Review the diff before tagging any release.

If you prefer to stay in control of when updates happen, disable silent
background updates at install time or any time after:

```text
nexara update --off    # disable silent background updates
nexara update --on     # re-enable them
nexara update --status # show the current mode and installed version
```

The installer also accepts `-DisableAutoUpdate` (PowerShell) or
`/DisableAutoUpdate` (Command Prompt) so silent background updates can be off
from the very first install. With updates disabled, run `nexara update`
whenever you want to install the latest version — it downloads from GitHub and
installs in the foreground so you see exactly what happened.
