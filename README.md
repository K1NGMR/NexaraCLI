# Nexara CLI

Nexara in your terminal: an interactive, streaming AI chat CLI with shared Nexara account limits, model selection, image attachments, saved conversations, and one-shot scripting.

It follows the useful parts of Claude Code's workflow without pretending to be Claude Code: run `nexara` for a session, pass a prompt for one-shot mode, use slash commands, resume a conversation, and pipe text into `nexara -p`.

## Requirements

- Node.js 20 or newer
- For Google sign-in from the CLI, the Supabase project must allow `http://127.0.0.1:54321/callback` as an authentication redirect URL.
- A Nexara account at https://nexara-ai-chat.vercel.app

## Install once

Install the latest Windows build directly from PowerShell:

```powershell
irm https://raw.githubusercontent.com/K1NGMR/NexaraCLI/main/install.ps1 | iex
```

The installer downloads the CLI from GitHub and installs the `nexara` command globally.

Then run it from PowerShell **or** Command Prompt:

```text
nexara
```

When you start Nexara in a new folder, it shows the workspace path and asks
you to trust it before continuing. Press `y` to remember that folder, or press
Enter to exit. Set `NEXARA_SKIP_WORKSPACE_TRUST=1` for non-interactive local
environments where the folder is already trusted by your own tooling.

Interactive startup clears the terminal viewport, shows an animated pixel-art
Nexara Petal mascot, and offers live described slash-command suggestions as you
type. Set `NEXARA_NO_ANIMATION=1` when using a slow terminal, screen reader, or
automated environment; set `NEXARA_NO_CLEAR=1` to keep the existing terminal
scrollback.

If you prefer the npm registry after the package is published:

```powershell
npm install --global nexara-cli
```

Command Prompt equivalent:

```cmd
curl -fL https://raw.githubusercontent.com/K1NGMR/NexaraCLI/main/install.cmd -o %TEMP%\\nexara-install.cmd && %TEMP%\\nexara-install.cmd && del %TEMP%\\nexara-install.cmd
```

### Updates: silent by default, opt out at install or any time

By default the CLI checks for new versions silently (at most every six hours, never blocking startup) and installs them in the background — you only notice a new version the next time you start `nexara`.

You can disable that before anything is installed:

```powershell
# PowerShell — no silent background updates on this machine
irm https://raw.githubusercontent.com/K1NGMR/NexaraCLI/main/install.ps1 | iex -DisableAutoUpdate
```

```cmd
rem Command Prompt
curl -fL https://raw.githubusercontent.com/K1NGMR/NexaraCLI/main/install.cmd -o %TEMP%\\nexara-install.cmd && %TEMP%\\nexara-install.cmd /DisableAutoUpdate && del %TEMP%\\nexara-install.cmd
```

…or flip the setting on an existing install whenever you like:

```text
nexara update --off     # disable silent background updates
nexara update --on      # re-enable them
nexara update --status  # show the current setting and installed version
```

With silent updates off, updating is fully manual and in your control — run `nexara update` and the CLI checks GitHub, downloads the newer version, and installs it in the foreground so you see exactly what happened:

```text
nexara update
> Updated 0.1.1 → 0.1.2. Restart nexara to use the new version.
```

Inside an interactive session the same action is `/update`. One-run opt-outs (`$env:NEXARA_NO_AUTO_UPDATE = "1"`) still work too. Whatever the setting, the next `nexara` session always runs the version that was installed.

For a local checkout:

```powershell
git clone https://github.com/K1NGMR/NexaraCLI.git
cd NexaraCLI
npm install
npm install --global .
```

The standalone source repository is https://github.com/K1NGMR/NexaraCLI. The package name can change when you publish it; the executable remains `nexara`. Checks run at most every six hours and never block offline startup.

## First run

```text
nexara login
nexara login --qr
```

Enter the same email and password used on Nexara Web. Use `nexara login --qr` to display a short-lived QR code and approve the CLI from a phone already signed in to Nexara. The refreshable Supabase session is stored in `%USERPROFILE%\\.nexara\\config.json` on Windows or `~/.nexara/config.json` on macOS/Linux. The file is permission-restricted where the operating system supports it. Never put a service-role key in this file.

Interactive conversations are also saved locally on the computer in `%USERPROFILE%\\.nexara\\sessions\\` on Windows or `~/.nexara/sessions/` on macOS/Linux. Each session is a JSON transcript containing its remote thread ID, messages, model, working directory, and timestamps. `/threads`, `/resume`, and `nexara --continue` use this local transcript first, with the remote thread as a fallback for older conversations. Use `--no-session-persistence` for a one-off run that should not create a local transcript.

Useful account commands:

```text
nexara whoami
nexara logout
nexara status
```

## Chat modes

```text
nexara                         # interactive REPL
nexara "Explain this error"    # one-shot prompt
nexara -p "Summarize this"     # print/non-interactive mode
cat build.log | nexara -p "Find the root cause"
nexara --continue              # open the last saved Nexara thread
nexara --continue "Continue the task" # send a one-shot continuation
nexara --model "DeepSeek V4 Flash" "Review this design"
nexara --image screenshot.png "What is wrong here?"
```

Interactive slash commands:

- `/help` — command reference
- `/model` or `/model <name>` — list or change the model
- `/models` — list every Nexara model
- `/image <path>` — attach a local image to the next message; repeat for more images
- `/image clear` — remove pending images
- `/think <prompt>`, `/research <prompt>`, `/perplexity <prompt>`, `/plan <prompt>`, `/honest <prompt>` — mode shortcuts
- `/goal <goal>` — work autonomously until `GOAL_ACHIEVED` or the safety turn cap
- `/new` — start a new saved thread
- `/resume [thread-id]` — resume the last or a selected local thread
- `/threads` — list conversations saved on this computer (and older remote threads)
- `/clear` — clear the local context and begin a new thread
- `/compact` — keep a compact local tail of the current context
- `/permission [mode]` — choose `Always ask`, `Approve for me`, `Sandboxed`, or `Full access` (the older `/permissions` alias is also supported)
- `/tools` — inspect the local tool surface available to the agent
- `/mcp`, `/skills`, `/plugins` — inspect workspace automation manifests
- `/agents`, `/background`, `/tasks`, `/logs <id>`, `/stop <id>` — monitor or control local background work
- `/download`, `/open <path>`, `/reveal <path>` — find and open generated artifacts
- `/config` — show the non-secret config and local session locations
- `/status` — show session, thread, and model status
- `/quit` or `/exit` — leave the session

Permission modes: `Always ask` prompts before mutating tools; `Approve for me`
automatically approves safe edits and commands while keeping destructive actions
behind a prompt; `Sandboxed` allows the agent to work freely inside the current
project (including Bash and local servers) but asks before accessing paths
outside it; `Full access` removes that outside-project approval boundary.

The agent can use a bidirectional local tool protocol. It shows the call before
running it, asks for approval for changes, returns the result to the model, and
continues the turn. The built-in surface includes file reads/writes and patches,
search/glob, allowlisted local commands, git inspection, background commands,
artifact opening, code navigation (`SymbolSearch`, `FindReferences`,
`LocateDefinition`, `CodeOutline`, `ImportGraph`, `DependencyTree`), type-check
diagnostics, and delegated read-only subagents. Local execution is confined to
the current workspace by default.

For scripts and CI, use the same controls without opening the REPL:

```text
nexara -p "Review this project" --output-format json
nexara -p "Run the tests and fix the failure" --permission-mode sandboxed --max-turns 12
nexara -p "Inspect the build" --output-format stream-json --max-budget 625000
nexara -p "Read-only audit" --allowed-tools Read,Search,Glob --disallowed-tools Bash
nexara -p "One-off task" --no-session-persistence
```

`--output-format stream-json` emits status/progress, text-delta, tool-call,
tool-result, approval-request, question, artifact, finish, and
cancellation/limit events for automation.
Press Ctrl+C once to cancel an active generation; press Escape twice to exit
the CLI entirely.
The CLI exits cleanly when Escape is pressed twice, including during sign-in or
workspace trust selection.
When a model emits reasoning, click the live `Thinking… (click to expand)` line
to open its emitted reasoning transcript; click again to collapse it. Models
that do not expose reasoning will only show the normal activity indicator.

## Voice input (push-to-talk)

At the REPL prompt, press **M** to start recording from your microphone, and press **M** again to stop and transcribe your words into the input line (speech-to-text via Nexara's server-side `openai/whisper-large-v3` transcription). Then press Enter to send, or edit the transcript first.

Recording works on Windows 10+ out of the box (built-in WinRT AudioGraph). If the first run says your microphone produced no audio, check that the mic isn't muted and that Windows allows desktop apps to use the microphone (Settings → Privacy & security → Microphone). If `ffmpeg` is on your PATH it is used as a fallback on other platforms.

```text
you ▸ (press M) 🎙  Recording… press M again to stop and transcribe
```

## Images

Images are read locally and sent to Nexara as standard multimodal UI message file parts. Supported types include PNG, JPEG, GIF, WebP, BMP, and SVG. The CLI rejects files larger than 3 MB before they reach the server; resize very large screenshots first because base64 encoding increases request size.

```text
nexara --image diagram.png "Explain this architecture"
```

## Configuration

The deployed Nexara defaults are included as public client configuration. Forks or self-hosted deployments can override them:

```powershell
$env:NEXARA_APP_URL = "https://your-deployment.example"
$env:NEXARA_SUPABASE_URL = "https://your-project.supabase.co"
$env:NEXARA_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_..."
```

The CLI never needs or accepts Nexara's server-side OpenRouter, Tavily, PayPal, Discord, or Supabase service-role secrets.

## Development

```text
npm install
npm run check
npm run smoke
npm run pack:check
```
