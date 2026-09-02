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
- `OPENROUTER_API_KEY`
- `XKIRO_API_KEYS` or `PAID_XKIRO_API_KEYS`
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
