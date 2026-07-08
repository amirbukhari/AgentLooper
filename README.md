# AgentLooper

> Autonomous multi-agent workspace simulator that runs entirely in your browser.

AgentLooper lets you spin up teams of LLM agents, give each a persona, and watch
them **spawn**, **delegate to**, and **schedule** one another on a live 1-second
tick loop. Agents reason with Google's Gemini models and can read/write real files
in your own Google Drive — all through a single static HTML page, with no backend
and no server-side secrets.

It ships with a **sandbox mode** (mock Drive + scripted flows) so you can explore
the whole system before connecting any Google account.

---

## Features

- **Dynamic agent orchestration.** Agents control each other through inline command
  tags in their responses:
  - `[CREATE_AGENT: name="...", persona="..."]` — spawn a new agent
  - `[TRIGGER_AGENT: name="...", task="..."]` — delegate a task
  - `[SCHEDULE_LOOP: name="...", interval_sec="10", limit="2", task="..."]` — run a
    task on a recurring loop
- **Real Google Workspace tools.** Once signed in, agents can act on your account —
  not just simulate. Available as inline tags alongside `[WRITE_GDRIVE]`/`[READ_GDRIVE]`:
  - `[SEND_GMAIL: to="...", subject="...", body="..."]` — send an email
  - `[DRAFT_GMAIL: to="...", subject="...", body="..."]` — save a draft for you to review
  - `[CREATE_EVENT: title="...", start="ISO", end="ISO", details="..."]` — add a calendar event
  - `[LIST_EVENTS: max="5"]` — read upcoming events back to the agent
  - `[WRITE_SHEET: name="...", values="a,b ; c,d"]` / `[READ_SHEET: name="..."]` — read/write a spreadsheet
- **Human-in-the-loop email gate.** Agents choose per email whether to send or draft, but a
  master **"Allow autonomous email sending"** switch (default **off**) is the final say:
  while it's off, even `[SEND_GMAIL]` is saved as a Gmail draft, so nothing leaves your
  account until you opt in.
- **Multiple workspaces ("Directories").** Isolate independent agent ecosystems and
  switch between them from the header. Every directory (its agents, task queue, and
  sandbox files) is **persisted to `localStorage`**, so a page reload restores your work.
- **Runaway-loop safety caps.** Because agents can spawn, trigger, and schedule each
  other, built-in limits (max agents, max queued tasks, and clamped loop
  interval/iterations) stop a self-referential chain from spawning unbounded agents and
  burning your Gemini quota.
- **Live scheduler.** A 1-second clock loop drives triggers, scheduled loops, and
  the task queue, with real-time observability on the agent message lines.
- **Bring-your-own Google account.** A single OAuth consent covers Gemini
  (`cloud-platform` + `generative-language.retriever` — both are required; `cloud-platform`
  alone gets rejected by the Gemini API with a 403), Drive (`drive.file`), Gmail
  (`gmail.compose`), Calendar (`calendar.events`), and Sheets (`spreadsheets`). Nothing is
  proxied through a server.
- **Sandbox vs. real Drive.** Start against mock files; flip to real Google Drive
  once signed in.
- **Starter presets.** A band-manager (default) and code-generation agent team are built in.
- **Export / Import.** Download any directory as a `.json` file from the header, and
  re-import it later (or on another machine/browser) — always as a new directory, so it
  never overwrites your current work.

## Quick start

The app is a single static file — the fastest way to try it is to open it directly:

```bash
# Option A: just open the file in a browser
open index.html          # macOS
xdg-open index.html      # Linux

# Option B: serve it locally (recommended — OAuth needs a real http origin)
npm install
npm run dev              # serves on http://localhost:8080 and opens a browser
```

> **Note:** Google Sign-In requires the page to be served from an authorized origin,
> not opened via `file://`. Use `npm run dev` (or the deployed GitHub Pages URL) when
> connecting a real Google account. Sandbox mode works from anywhere.

## Configuration

The Google OAuth client is baked into the page (this is normal — an OAuth **client
ID** is public and is restricted server-side to authorized origins; only a client
_secret_ must stay private, and this browser-only flow never uses one).

To point AgentLooper at your **own** Google Cloud project, edit these constants near
the top of the `<script>` block in [`index.html`](index.html):

```js
const GOOGLE_OAUTH_CLIENT_ID = '...apps.googleusercontent.com';
const GOOGLE_CLOUD_PROJECT_ID = 'your-project-id';
```

Then, in the [Google Cloud Console](https://console.cloud.google.com/):

1. Create an OAuth 2.0 **Web application** client ID.
2. Add your origin(s) (e.g. `http://localhost:8080` and your Pages URL) to
   **Authorized JavaScript origins**.
3. Enable the APIs the tools use: **Gemini API**, **Google Drive API**, **Gmail API**,
   **Google Calendar API**, and **Google Sheets API**.
4. Add the required scopes to the OAuth consent screen: `cloud-platform`,
   `generative-language.retriever`, `drive.file`, `userinfo.email`, `gmail.compose`,
   `calendar.events`, `spreadsheets`.

> **Gemini calls need _both_ `cloud-platform` and `generative-language.retriever`.**
> `cloud-platform` alone is not sufficient — Google's Generative Language API
> (`generativelanguage.googleapis.com`) rejects it with `403 Request had insufficient
authentication scopes` unless `generative-language.retriever` is also granted. If you
> add this scope after users have already signed in, they must sign out and sign in again
> — a previously-issued token won't retroactively gain the new scope.

> The Gmail, Calendar, and Sheets tools only appear to agents once a real Google account
> is connected — in sandbox mode agents only see the Drive tools.

The Gemini model is set inline (currently `gemini-2.5-flash-preview-09-2025`); search
for `generativelanguage.googleapis.com` in `index.html` to change it.

## Project structure

```
.
├── index.html              # The entire application (markup + styles + logic)
├── package.json            # Scripts and dev tooling
├── eslint.config.js        # HTML linting (@html-eslint)
├── .prettierrc.json        # Formatting rules
├── .editorconfig           # Cross-editor defaults
└── .github/workflows/
    ├── ci.yml              # Lint on every push / PR
    └── pages.yml           # Deploy to GitHub Pages
```

## Development

| Command                | What it does                                        |
| ---------------------- | --------------------------------------------------- |
| `npm run dev`          | Serve on `http://localhost:8080` and open a browser |
| `npm start`            | Serve without opening a browser                     |
| `npm run lint`         | Lint `index.html` for structural HTML issues        |
| `npm run lint:fix`     | Auto-fix lint issues where possible                 |
| `npm run format`       | Format all files with Prettier                      |
| `npm run format:check` | Report formatting issues without writing            |

> `index.html` predates the formatter and is intentionally left hand-formatted, so
> `format:check` reports it. Running `npm run format` will bring it in line, but
> produces a large one-time diff — apply it deliberately. CI runs `lint` only.

## Deployment

Pushing to the default branch triggers
[`.github/workflows/pages.yml`](.github/workflows/pages.yml), which publishes the
site to GitHub Pages. Because the app is fully static, the "build" is just uploading
the repository contents (minus `.git`/`.github`).

Remember to add your deployed Pages URL to the **Authorized JavaScript origins** of
your Google OAuth client so sign-in works in production.

## License

[MIT](LICENSE)
