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

The installer downloads the CLI from GitHub, installs the `nexara` command globally, and enables silent background update checks. When a newer CLI version is published, it is downloaded and installed automatically; start a new `nexara` session to use it. No repeat download command is needed.

Then run it from PowerShell **or** Command Prompt:

```text
nexara
```

If you prefer the npm registry after the package is published:

```powershell
npm install --global nexara-cli
```

Command Prompt equivalent:

```cmd
curl -fL https://raw.githubusercontent.com/K1NGMR/NexaraCLI/main/install.cmd -o %TEMP%\\nexara-install.cmd && %TEMP%\\nexara-install.cmd && del %TEMP%\\nexara-install.cmd
```

For a local checkout:

```powershell
git clone https://github.com/K1NGMR/NexaraCLI.git
cd NexaraCLI
npm install
npm install --global .
```

The standalone source repository is https://github.com/K1NGMR/NexaraCLI. The package name can change when you publish it; the executable remains `nexara`. Auto-updates can be disabled for one run with `$env:NEXARA_NO_AUTO_UPDATE = "1"`; checks run at most every six hours and never block offline startup.

## First run

```text
nexara login
nexara login --qr
```

Enter the same email and password used on Nexara Web. Use `nexara login --qr` to display a short-lived QR code and approve the CLI from a phone already signed in to Nexara. The refreshable Supabase session is stored in `%USERPROFILE%\\.nexara\\config.json` on Windows or `~/.nexara/config.json` on macOS/Linux. The file is permission-restricted where the operating system supports it. Never put a service-role key in this file.

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
- `/resume [thread-id]` — resume the last or a selected thread
- `/threads` — list recent saved threads
- `/clear` — clear the local context and begin a new thread
- `/compact` — keep a compact local tail of the current context
- `/config` — show the non-secret CLI config location
- `/status` — show session, thread, and model status
- `/quit` or `/exit` — leave the session

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
