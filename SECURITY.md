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
