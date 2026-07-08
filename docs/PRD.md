# AgentLooper — Product Requirements Document

**Status:** Draft (reverse-engineered from current implementation, verified against `index.html`)
**Owner:** Amir Bukhari
**Last updated:** 2026-07-08

## 1. Summary

AgentLooper is a browser-only, single-page simulator for autonomous multi-agent
workspaces. Users define LLM-backed "agents" with personas, watch them spawn,
delegate to, and schedule one another on a live tick loop, and — once signed in
with a Google account — let those agents read/write real Google Drive files,
send/draft Gmail, manage Calendar events, and read/write Sheets. There is no
backend: all state, orchestration, and API calls happen client-side in
`index.html`, with Google OAuth providing the only external trust boundary.

The product exists to let a single user experiment with emergent multi-agent
behavior (spawn chains, delegation graphs, scheduled loops) against both a
mock sandbox and their real Google Workspace account, with enough guardrails
that an unsupervised agent chain can't run away or take unwanted real-world
actions (e.g., sending an email) without explicit opt-in.

**Done, for this PRD's scope:** an implementer can read this document alone
and reproduce the current `index.html` behavior byte-for-byte in intent
(exact data shapes, exact tag grammar, exact failure behavior) without
reading the source or asking a clarifying question.

## 2. Goals

- Let a user create and run multiple LLM agents that can autonomously spawn,
  trigger, and schedule each other via inline command tags in model output.
- Provide a zero-install, zero-backend way to try this (open `index.html` or a
  static Pages deployment) with a **sandbox mode** requiring no Google account.
- Let a signed-in user point agents at their **real** Google Drive, Gmail,
  Calendar, and Sheets, using only browser-side OAuth (no server, no stored
  secrets).
- Prevent runaway agent chains (infinite spawn/trigger/schedule loops) from
  exhausting the user's Gemini quota or API rate limits.
- Prevent agents from taking irreversible real-world actions (sending email)
  without an explicit, visible, revocable user opt-in.
- Persist a user's work (agents, task queue, sandbox files) across page
  reloads, and let them run multiple independent agent ecosystems
  ("directories") side by side — creating, renaming, deleting, and
  exporting/importing them as needed.
- Surface task failures visibly (not silently) so a user can tell a broken
  agent loop from a working one at a glance.

## 3. Non-goals

- No multi-user / multi-tenant support — this is a single-browser,
  single-Google-account tool with no shared server state.
- No support for LLM providers other than Google Gemini.
- No mobile-specific UI; desktop browser is the target.
- No durable/server-side agent execution — if the tab closes, the tick loop
  stops (state up to that point is saved to `localStorage`, but nothing
  continues running in the background).
- No fine-grained per-tool permissioning beyond the existing Gmail
  autonomy gate — Calendar and Sheets writes are never gated or drafted,
  only Gmail sends are (see 7.4).
- No cross-tab/cross-window coordination: the same directory open in two
  tabs at once is unsupported (see 7.7).
- No accessibility conformance target (e.g., a WCAG level) for this
  iteration — the UI carries some ARIA attributes incidentally but is not
  audited or tested against a standard.
- No automatic retry of a failed task — retry is a deliberate, one-at-a-time
  user action (see 7.1); the app never re-attempts a failed task on its own.
- No overwrite-on-import: importing a file always creates a new directory
  (suffixed on name collision) rather than restoring over an existing one
  by name (see 7.9, Open questions).

## 4. Target user

A single technical user (e.g., a developer or hobbyist) experimenting with
agentic/multi-agent LLM behavior who wants to:

- Prototype agent-to-agent delegation patterns without standing up
  infrastructure.
- Optionally connect real Google Workspace data/actions to observe agents
  taking real, useful actions, while keeping a manual safety net on the one
  action that leaves the account (email).

## 5. Core concepts

- **Agent** — a named persona with a system-prompt-like description, a memory
  log, and a color theme. Agents respond to tasks by calling the Gemini API
  and can emit inline command tags that the app parses out of the response
  text. Full schema: 6.1.
- **Directory** — an isolated workspace: its own set of agents, task queue,
  sandbox files, and UI graph layout. Users can create, rename, delete, and
  switch between multiple directories; each is persisted independently in
  `localStorage`. Full schema: 6.3, lifecycle: 7.7.
- **Task queue / scheduler** — a live 1-second tick loop that dequeues
  pending, due queue entries (oldest-array-index first) and dispatches them
  to the named agent, one at a time (the app never runs two tasks
  concurrently). A task that errors becomes visibly `"failed"` rather than
  silently vanishing. Full schema: 6.2, failure behavior: 7.1.
- **Command tags** — the mechanism by which an agent's text output becomes an
  action. Full per-tag grammar and failure behavior: 7.1 and 7.3.
- **Sandbox mode** — the default, no-auth mode. Agents only see the
  `WRITE_GDRIVE`/`READ_GDRIVE` mock file tools; Gmail/Calendar/Sheets tools
  are not advertised to the model until a real Google account is connected.
- **Presets** — built-in starter ecosystems that populate a directory with a
  ready-made set of agents: a **band-manager** preset (default) and a
  **code-generation** agent team. Applied automatically only to an empty
  directory, or explicitly (and destructively) via the Starter Presets
  panel. Full spec: 7.6.
- **AI Architect ecosystem builder** — a one-shot Gemini call, distinct from
  a preset, that generates a 2–4-agent team from a free-text goal the user
  types in, and adds it into the current directory. Full spec: 7.8.
- **Export / Import** — a single directory, or every directory at once (a
  full backup), can be downloaded as a portable JSON file and later
  re-imported (always as new, uniquely-named directories — never
  overwriting existing work). Full spec: 7.9.

## 6. Data model

All entities below live in browser memory during a session and are
serialized verbatim (via `JSON.stringify`) into `localStorage` on
`persistState()`. There is no server-side or database representation.

### 6.1 Agent

Stored as `agents[id]` inside the active directory.

| Field         | Type     | Required | Notes                                                                                                                                                                                                                                                                                                                                                                     |
| ------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | string   | yes      | The object key. Derived from the user/agent-supplied name by stripping every character that is not `[A-Za-z0-9]` (`name.replace(/[^a-zA-Z0-9]/g, "")`). If this produces an empty string, creation is rejected — see 7.1.                                                                                                                                                 |
| `persona`     | string   | yes      | Free-text system-prompt-style description, injected verbatim into the Gemini system instruction for that agent.                                                                                                                                                                                                                                                           |
| `theme`       | string   | yes      | UI color tag only — one of `brand`, `amber`, `emerald`, `rose`, `cyan`. Manually created / preset agents get an explicit value (default `brand`); agents auto-spawned via `[CREATE_AGENT]` or trigger-fallback get one picked at random from `["emerald","rose","cyan","amber","brand"]`.                                                                                 |
| `memory`      | string[] | yes      | A rolling log, newest-first (`unshift`). Two entries are added per completed task: `"[Received Task Prompt]: <first 80 chars of task>..."` then `"[AI Output]: <first 100 chars of Gemini's response>..."`. Capped at 50 entries (oldest popped once exceeded). Seeded with one string at creation (e.g. `"Manually registered and spawned by User workspace command."`). |
| `createdTime` | Date     | yes      | Set once at creation; never updated.                                                                                                                                                                                                                                                                                                                                      |

**Uniqueness:** `id` must be unique within a directory. The manual "create
agent" form and the `[CREATE_AGENT]` tag both check `agents[id]` first and
reject the operation (toast or console message, no state change) if it
already exists. Two paths do **not** perform this check and will silently
overwrite an existing agent with the same id: the bulk "AI ecosystem
generator" (`autogenerateEcosystem`) and the `[TRIGGER_AGENT]` fallback that
auto-spawns a missing target (see 7.1) — both assign `agents[cleanName] = {...}`
unconditionally.

### 6.2 Task queue entry

Held in the active directory's `taskQueue` array; the scheduler tick scans
it in array order and runs the first entry that is both `status: "pending"`
and due (`scheduledTime <= Date.now()`).

| Field              | Type                                        | Required                      | Notes                                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | string                                      | yes                           | `crypto.randomUUID()`.                                                                                                                                                                                                 |
| `fromAgent`        | string                                      | yes                           | Originating agent's `id`, or the literal string `"User"` for manually enqueued tasks, or `"GDrive"` for the follow-up task queued by a `[READ_GDRIVE]`/`[READ_SHEET]`.                                                 |
| `toAgent`          | string                                      | yes                           | Target agent's `id`.                                                                                                                                                                                                   |
| `type`             | `"once"` \| `"loop"`                        | yes                           |                                                                                                                                                                                                                        |
| `promptText`       | string                                      | yes                           | The task text sent to the agent as the Gemini user turn.                                                                                                                                                               |
| `scheduledTime`    | number (epoch ms)                           | yes                           |                                                                                                                                                                                                                        |
| `status`           | `"pending"` \| `"processing"` \| `"failed"` | yes                           | `"failed"` means the task errored and is awaiting a manual Retry or Dismiss — see 7.1 Task failure behavior. There is still no `"done"` status: a successful task is removed from the queue entirely, not marked done. |
| `error`            | string                                      | only if `status: "failed"`    | The thrown error's message. Cleared (deleted) whenever the task transitions out of `"failed"` (Retry) or starts a fresh attempt.                                                                                       |
| `lastError`        | string                                      | optional, `type: "loop"` only | Set when a loop iteration fails but the loop still has iterations left (so it reschedules as `"pending"` instead of `"failed"`) — a breadcrumb of the most recent failure without stopping the loop.                   |
| `intervalSec`      | number                                      | only if `type: "loop"`        | Clamped to `[5, 3600]` via `clampLoopInterval` (5 = `MIN_LOOP_INTERVAL_SEC`, 3600 = `MAX_LOOP_INTERVAL_SEC`); unparsable input falls back to 10 before clamping.                                                       |
| `currentIteration` | number                                      | only if `type: "loop"`        | Starts at 1.                                                                                                                                                                                                           |
| `maxIterations`    | number                                      | only if `type: "loop"`        | Clamped to `[1, 20]` via `clampLoopIterations`; unparsable input falls back to 3 before clamping.                                                                                                                      |
| `aborted`          | boolean                                     | optional                      | Set `true` and the entry is immediately spliced out of the queue when the user cancels/dismisses it from the UI (works identically for pending, processing, and failed tasks).                                         |

### 6.3 Directory (workspace)

Held in a top-level `workspaces` object keyed by the directory's **raw,
user-entered name**, trimmed but _not_ alphanumeric-sanitized (unlike agent
ids — directory names may contain spaces/punctuation and are case-sensitive
exact-match keys).

| Field                 | Type                                                                 | Notes                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents`              | `{ [agentId]: Agent }`                                               |                                                                                                                                              |
| `taskQueue`           | `TaskQueueEntry[]`                                                   |                                                                                                                                              |
| `positions`           | `{ [nodeId]: { x: number, y: number } }`                             | UI graph-layout coordinates; always seeded with `User` (`{x:50,y:15}`) and `GDrive` (`{x:85,y:18}`) pseudo-nodes.                            |
| `completedTasksCount` | number                                                               | Incremented only when a task actually completes successfully — a task that ends up `status: "failed"` does **not** increment this (see 7.1). |
| `mockGDriveFiles`     | `{ name: string, size: string, content: string, updated: string }[]` | Sandbox-mode virtual file store. `size` is a display string (e.g. `"42 B"`), not a number. Ignored in real-Drive mode.                       |

### 6.4 Persistence keys

| Key                    | Store            | Shape                                                                      | Notes                                                                                                                                                                   |
| ---------------------- | ---------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentlooper_state_v1` | `localStorage`   | `{ workspaces: { [directoryName]: Directory }, currentWorkspace: string }` | Written on `beforeunload` and after most state-mutating actions. No schema-version field — a future field rename/removal is not migration-safe against old saved state. |
| `agentlooper_autosend` | `localStorage`   | `"1"` \| `"0"`                                                             | The human-in-the-loop email gate (7.4), stored independently of any directory.                                                                                          |
| `agentos_google_token` | `sessionStorage` | `{ access_token: string, expires_at: number (epoch ms) }`                  | The live Google OAuth access token. Deliberately **not** written to `localStorage` — cleared when the tab session ends, and never included in the directory blob.       |

On boot (or Import — see 7.9), any task queue entry restored with
`status: "processing"` is reset to `"pending"` (recovers a task that was
mid-execution when the tab closed or the file was exported). A restored
`status: "failed"` entry is left as `"failed"` — it survives a reload exactly
as the user left it.

## 7. Functional requirements

### 7.1 Agent orchestration and command tags

- Users can manually create an agent (name + persona + theme) via a form,
  and manually enqueue a task for any existing agent (target, type
  `once`/`loop`, prompt, and — for `loop` — interval/iteration count).
- Users can inspect any agent read-only via a modal
  (`inspectAgent`/`agent-inspect-modal`) showing its `id`, full `persona`
  text, and its full `memory` array rendered newest-first (an empty
  `memory` array shows the placeholder text "Ephemeris logs are currently
  empty. Execute loops to gather history." instead of an empty list). A
  parallel read-only modal exists for inspecting a sandbox Drive file's
  content. Both modals close via an explicit close control or the `Escape`
  key (whichever modal is open takes precedence: file-inspect modal is
  checked first, then agent-inspect modal — only one is ever open at a
  time).
- Agents act by emitting inline tags anywhere in their Gemini response text;
  the app parses all occurrences of all tag types out of that text with
  regexes and executes each one, in the fixed order listed below, once per
  completed agent response. Unrecognized/malformed tag text (e.g., missing
  a required attribute, or not matching the tag's exact `key="value"`
  grammar) is not detected as an error — it simply fails to match the regex
  and is left inert in the displayed response text; no warning is logged
  for this case specifically (only the explicit rejections below produce a
  log line). Worked example: an agent emitting
  `[CREATE_AGENT: name="Bob"]` (persona attribute omitted) does not match
  the `[CREATE_AGENT: name="...", persona="..."]` regex at all — no agent is
  created, no cap check runs, no log line appears, and the literal text
  `[CREATE_AGENT: name="Bob"]` remains visible in the agent's displayed
  response. The same applies to any other tag in the table below missing a
  required attribute or using single quotes / no quotes around a value.
- The scheduler tick runs on a 1-second `setInterval`, processes **at most
  one** due `pending` entry per tick, and will not start a new one while
  another is `status: "processing"` (`processingTask` flag). Entries with
  `status: "failed"` are never picked up automatically — only a `pending`
  entry (whether newly enqueued or reset via Retry) is eligible.

**Per-tag grammar and behavior:**

| Tag                                                                    | Required attributes                                                                                | Behavior on success                                                                                                                                                                                              | Behavior on failure/edge case                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[CREATE_AGENT: name="...", persona="..."]`                            | `name`, `persona` (both required by regex; tag doesn't match without both)                         | Registers a new agent (6.1) with a random theme.                                                                                                                                                                 | Empty name after sanitization → silently skipped (no log). Name already registered → skipped, logs `"Agent '<name>' already registered. Skipping dynamic spawn."`. Directory at `MAX_AGENTS` (40) → skipped, logs the agent-cap error.                                                                                                                                                                                                                                                                                                         |
| `[TRIGGER_AGENT: name="...", task="..."]`                              | `name`, `task`                                                                                     | Enqueues a `once` task to the target agent, `scheduledTime = now`.                                                                                                                                               | Empty target name → silently skipped. Target agent doesn't exist **and** directory is at `MAX_AGENTS` → skipped, logs the agent-cap error. Target agent doesn't exist and directory has capacity → **auto-spawns a generic fallback clone agent** (persona: `"You are a helper clone agent named <name>. Deliver logical structured feedback."`), logs `"Cannot trigger '<name>': Agent does not exist. Spawning standard clone..."`, then proceeds to enqueue the task on it. Queue at `MAX_QUEUE` (60) → skipped, logs the queue-full error. |
| `[SCHEDULE_LOOP: name="...", interval_sec="N", limit="N", task="..."]` | `name`, `interval_sec`, `limit`, `task`                                                            | Enqueues a `loop` task, first run at `now + interval_sec*1000`.                                                                                                                                                  | Empty target name → silently skipped. Target agent doesn't exist → skipped **without auto-spawning** (unlike `TRIGGER_AGENT`), logs `"Loop target '<name>' missing. Loop scheduling skipped."`. Queue at `MAX_QUEUE` → skipped, logs the queue-full error. `interval_sec`/`limit` are clamped per 6.2, not rejected.                                                                                                                                                                                                                           |
| `[WRITE_GDRIVE: filename="...", content="..."]`                        | `filename`, `content`                                                                              | Sandbox: upserts into `mockGDriveFiles` by exact name match. Real Drive: searches the app's Drive workspace folder for a file with that exact name and PATCHes it, or creates it via multipart upload if absent. | Real-Drive mode without an authenticated session/workspace folder → logs an "unauthenticated" error, no queue/state change. Real-Drive API failure → caught, logs a generic connection-failure error.                                                                                                                                                                                                                                                                                                                                          |
| `[READ_GDRIVE: filename="..."]`                                        | `filename`                                                                                         | Looks up the file by exact name; on found, enqueues a `once` follow-up task back to the requesting agent (`fromAgent: "GDrive"`, `scheduledTime: now + 1000`) whose prompt embeds the file's full content.       | File not found (sandbox or real) → logs a "not found" error, no follow-up task. Unauthenticated in real-Drive mode → logs an "unauthenticated" error.                                                                                                                                                                                                                                                                                                                                                                                          |
| `[SEND_GMAIL: to="...", subject="...", body="..."]`                    | `to`, `subject` (may be empty string), `body`                                                      | If the master autonomous-send gate (7.4) is on, sends the email via Gmail API; if off, saves it as a Gmail draft instead.                                                                                        | Google tools not connected (`googleToolsReady()` false) → skipped, logs a "sign in" error, no draft/send attempted. API call throws → caught, logs a Gmail error.                                                                                                                                                                                                                                                                                                                                                                              |
| `[DRAFT_GMAIL: to="...", subject="...", body="..."]`                   | same as above                                                                                      | Always saves a Gmail draft, regardless of the autonomous-send gate.                                                                                                                                              | Same failure modes as `SEND_GMAIL`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `[CREATE_EVENT: title="...", start="...", end="...", details="..."]`   | `title`, `start` required; `end` and `details` optional (regex allows them to be omitted entirely) | Creates a primary-calendar event via the Calendar API.                                                                                                                                                           | Not connected → skipped, logs a "sign in" error. API call throws (e.g., invalid ISO datetime) → caught, logs an error naming the likely cause.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `[LIST_EVENTS]` or `[LIST_EVENTS: max="N"]`                            | none (`max` optional, default 5)                                                                   | `max` is clamped to `[1, 25]`; fetches upcoming events and enqueues the results back to the agent as context (implementation detail of `calendarListTool`).                                                      | Not connected → skipped, logs a "sign in" error. API failure → caught, logs an error.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `[WRITE_SHEET: name="...", values="a,b ; c,d"]`                        | `name`, `values`                                                                                   | Creates/overwrites a spreadsheet by name; rows split on `;`, cells split on `,`.                                                                                                                                 | Not connected → skipped, logs a "sign in" error. API failure → caught, logs an error.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `[READ_SHEET: name="..."]`                                             | `name`                                                                                             | Reads a spreadsheet's contents back to the agent (implementation detail of `sheetReadTool`).                                                                                                                     | Not connected → skipped, logs a "sign in" error. API failure → caught, logs an error.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

**Task failure behavior:** if `executeTaskNode` throws for any reason
(target agent no longer exists, or `callGemini` exhausts its retries — see
7.3), the scheduler's `catch` block logs a single
`"Task failure on execution pipeline: <message>"` SYSTEM error line, then the
`finally` block branches on task type and position:

- **`once` task, or a `loop` task on its last iteration:** the task's
  `status` becomes `"failed"` and `error` is set to the thrown message. The
  task is **not** removed from the queue and `completedTasksCount` does
  **not** increment — this is the visible failure state, distinct from a
  successful completion. The agent's `memory` is not updated (the
  memory-append lines only run after a successful `callGemini` return).
- **`loop` task with iterations remaining:** unchanged from a successful
  iteration in every respect except one — `task.lastError` is set to the
  thrown message (a breadcrumb, not a status change) and the SYSTEM
  reschedule log line is logged at `"error"` level instead of `"info"` and
  says `"(previous iteration failed: <message>)"`. `currentIteration` still
  advances and `status` still returns to `"pending"` for the next run — a
  single failed iteration does not stop the loop.

A task with `status: "failed"` sits in the Task Queue panel with a red
"Failed" badge and its error message shown inline, and offers two manual
actions:

- **Retry** (`retryTask`): resets `status` to `"pending"`, `scheduledTime` to
  now, and clears `error` — the scheduler picks it up on its next tick like
  any other due task.
- **Dismiss** (reuses `cancelTask`, same control as aborting any other
  task): removes it from the queue immediately.

There is no automatic retry — a failed task sits inert until the user acts
on it, and (per 7.2) still counts against `MAX_QUEUE` until they do.

### 7.2 Safety caps (runaway-loop protection)

- **Max agents per directory:** 40 (`MAX_AGENTS`). Enforced identically for
  manual creation, `[CREATE_AGENT]`, `[TRIGGER_AGENT]`'s auto-spawn
  fallback, and the bulk AI-ecosystem generator.
- **Max queued tasks:** 60 (`MAX_QUEUE`), checked before every enqueue
  (manual, `[TRIGGER_AGENT]`, `[SCHEDULE_LOOP]`). `status: "failed"` tasks
  left undismissed count toward this cap exactly like `pending`/`processing`
  ones — a directory with many un-dismissed failures can hit `MAX_QUEUE`
  and start rejecting new tasks until the user retries or dismisses some.
- **Scheduled-loop interval:** clamped to `[5, 3600]` seconds
  (`MIN_LOOP_INTERVAL_SEC`–`MAX_LOOP_INTERVAL_SEC`); values outside this
  range are silently clamped, not rejected.
- **Scheduled-loop iterations:** clamped to `[1, 20]` (`MAX_LOOP_ITERATIONS`
  ceiling; the floor of 1 comes from `Math.max(..., 1)` in
  `clampLoopIterations`).
- **Console feed cap:** 200 blocks (`MAX_CONSOLE_BLOCKS`); oldest entries
  trimmed from the DOM once exceeded — this affects only the on-screen feed,
  not any persisted log (there is no persisted action log; see 10).
- All caps apply uniformly whether the triggering actor is the user (via UI)
  or another agent (via inline tag); exceeding any cap never throws — it
  always degrades to a skipped action plus a logged SYSTEM message.

### 7.3 Google Workspace integration

- A single Google OAuth consent (Google Identity Services token client)
  grants scopes for: Gemini (`cloud-platform`), Drive (`drive.file`), Gmail
  (`gmail.compose`), Calendar (`calendar.events`), Sheets (`spreadsheets`),
  and `userinfo.email`.
- The resulting access token and its expiry are held in
  `sessionStorage["agentos_google_token"]` (6.4) — never in `localStorage`.
  On boot, `restoreGoogleSession()` reuses the stored token only if it has
  more than 30 seconds of validity left; otherwise it's discarded and the
  user must sign in again (no silent refresh).
- **Token expiry/revocation mid-session:** every Gmail/Calendar/Sheets/
  Gemini API call goes through a shared request path that treats HTTP `401`
  and `403` as permanent for the current token: it clears
  `googleAuth.accessToken`, deletes the `sessionStorage` entry, updates the
  sign-in UI to signed-out, and throws an error surfaced to the console feed
  telling the user to sign in again. A scheduled loop that hits this simply
  fails that iteration per 7.1's task-failure behavior; it is not
  auto-paused or specially flagged.
- **Gemini API error handling (`callGemini`):** up to 5 attempts with
  exponential backoff starting at 1000ms (doubling each retry, honoring a
  numeric `Retry-After` response header when present) for network-transport
  errors, HTTP `429`, and HTTP `5xx`. HTTP `401`/`403` are treated as
  permanent (see above, no retry). Other `4xx` responses are treated as
  permanent (no retry). An empty/blocked model response (no `text` in the
  candidate) fails immediately without retrying. Exhausting all retries
  throws, which is caught by the task-failure path in 7.1.
- After sign-in, the app detects and warns the user (toast + console log +
  `console.warn`) if the `cloud-platform` scope was not actually granted
  (e.g., the user unchecked it in the consent screen), since Gemini calls
  will otherwise fail with an opaque 403.
- A live **Connectors panel** shows per-service (Gmail, Calendar, Sheets)
  connection status and a short recent-activity log
  (`logConnectorActivity`), populated from the same tag-execution paths in
  7.1. Each service also has a manual refresh button
  (`refreshGmailConnector`/`refreshCalendarConnector`/`refreshSheetsConnector`)
  that re-fetches its live data (draft count, upcoming events, spreadsheet
  list) directly from the API on demand, independent of any tag execution.
- Gmail, Calendar, and Sheets tags are only advertised to the model in its
  system instruction when `googleToolsReady()` is true (i.e., real Google
  auth is active); in sandbox mode the model is never told these tools
  exist, though the tags would still no-op safely (logged error) if an
  agent emitted them anyway.
- Real Drive mode scopes all agent Drive reads/writes to a single app-owned
  folder (`DRIVE_WORKSPACE_FOLDER_NAME`), consistent with the `drive.file`
  scope; sandbox mode uses the in-memory `mockGDriveFiles` array instead
  (6.3).

### 7.4 Human-in-the-loop email gate

- A master toggle, **"Allow autonomous email sending"**
  (`allowAutonomousSend`), defaults to **off** and persists to
  `localStorage["agentlooper_autosend"]` independently of any directory.
- While off, any `[SEND_GMAIL]` tag is converted to a Gmail **draft**
  instead of being sent — nothing leaves the user's account without the
  toggle being explicitly turned on.
- `[DRAFT_GMAIL]` always creates a draft regardless of the toggle.
- The toggle is a manual UI checkbox; no code path lets an agent tag change
  it. This gate covers Gmail sends only — Calendar event creation and
  Sheets writes are never gated or drafted (see Non-goals, 3).

### 7.5 Persistence

- `persistState()` writes `workspaces` and `currentWorkspace` to
  `localStorage["agentlooper_state_v1"]` (6.4) on `beforeunload` and after
  most mutating actions (agent create/deregister, task enqueue/cancel/retry,
  directory create/rename/delete/switch, Export/Import, Gmail/Calendar/
  Sheets/Drive tag execution).
- On boot, `loadPersistedState()` restores this blob if present and valid
  (a non-empty `workspaces` object), resets any `"processing"` task back to
  `"pending"` (6.4), and falls back to seeding the default band-manager
  preset only if no valid saved state exists.
- The Google OAuth token is never part of this persisted blob (7.3) — a
  restored session always requires either a still-valid `sessionStorage`
  token or a fresh sign-in.

### 7.6 Presets

Two built-in presets, keyed `band` (default, agents: Manager/Booking/Merch)
and `code` (agents: Architect/Coder/Tester), each defining a fixed set of
agents (name, persona, theme) and an `initialTask` (`target` agent id +
`prompt` text). There are two distinct, differently-behaved paths that use
this data:

- **Automatic seed-on-empty** (`loadWorkspaceState`, used at boot and when
  switching to/creating a directory): seeds the `band` preset **only** when
  the target directory currently has **zero** agents
  (`Object.keys(state.agents).length === 0`); a directory that already has
  at least one agent is left untouched by this path. This only ever fires
  automatically for the default/restored boot workspace — directories
  created via 7.7's "Create" flow start empty and are not auto-seeded.
- **Manual "Load Preset" action** (`loadDemoPreset`, triggered by the
  **Starter Presets** panel's "Band Manager" / "Code Generation" buttons in
  the Agent Hub tab): unconditionally **replaces** the current directory's
  `agents`, `taskQueue`, and node `positions` with the chosen preset's
  agents and a freshly reset queue/graph layout, **regardless of whether the
  directory already has agents** — this is a destructive reset, not an
  additive seed. It also clears the console feed (`clearConsole()`) and
  pre-fills the task-prompt field and task-target-agent select from the
  preset's `initialTask`. It is blocked with a toast
  (`"Clear active running tasks before loading presets."`) while any task in
  the directory is `status: "processing"`, and shows a success toast
  (`"Loaded preset environment: <band|code>"`) otherwise.

### 7.7 Directory lifecycle

- **Create:** via a native browser `prompt()` dialog asking for a name. The
  name is trimmed but not otherwise sanitized (may contain any characters).
  Creation is rejected with a toast if a directory with that **exact**
  string already exists (`workspaces[name]` truthy check, case-sensitive).
  A newly created directory starts with zero agents, an empty task queue,
  and no sandbox files (the default preset is _not_ auto-seeded into an
  explicitly-created directory — only the initial boot workspace is).
- **Rename** (`renameCurrentWorkspacePrompt`): via a native `prompt()`
  dialog pre-filled with the current directory's name. Renaming is a pure
  key move — `workspaces[newName] = workspaces[oldName]` then
  `delete workspaces[oldName]` — so agents, task queue, and everything else
  are untouched; it is safe to rename even while a task is `"processing"`
  (nothing about the rename touches the live scheduler). Cancelling the
  prompt, submitting the unchanged name, or submitting a blank name are all
  no-ops. Renaming to a name that collides with an existing directory
  (exact string match) is rejected with the same
  `"A directory with that name already exists."` toast used by Create.
- **Delete** (`deleteCurrentWorkspacePrompt`): requires confirming a native
  `confirm()` dialog. Blocked (with a toast, no state change) in two cases:
  the directory has a `status: "processing"` task
  (`"Cannot delete a directory while an agent task is active."`), or it is
  the only remaining directory
  (`"Cannot delete the only remaining directory."` — the app always needs
  at least one). On a confirmed delete, the directory's key is removed from
  `workspaces` and the app switches to whichever directory happens to be
  first in the (now-shrunk) `workspaces` object — there is no "most
  recently used" ordering, just object key order.
- **Switch:** selecting a different directory from the dropdown saves the
  current directory's live state, then loads the target directory's saved
  state into the active in-memory variables (`agents`, `taskQueue`, etc.).
  Switching is blocked with a toast
  (`"Cannot switch workspaces while an agent task is active."`) while any
  task is `status: "processing"`; the dropdown selection is reverted in
  that case.
- **Concurrency:** only the active directory's task queue is ever ticked —
  switching away stops that directory's scheduler from running (its
  `taskQueue` array is saved as static data, not iterated again until it's
  reactivated). Two directories never run concurrently in one tab.

### 7.8 AI Architect ecosystem builder (`autogenerateEcosystem`)

A separate, one-shot Gemini call — distinct from the per-agent task calls in
7.1 — that bulk-generates a small multi-agent team from a single free-text
goal, additively into the current directory.

- **Input:** a single free-text "goal" string from a dedicated UI field. An
  empty/whitespace-only goal is rejected client-side with a toast
  ("Please describe what ecosystem you want to build.") and no API call is
  made.
- **Request:** one `callGemini` call (same retry/backoff policy as 7.3) with
  a fixed architect system prompt instructing the model to design 2–4
  agents, and `generationConfig.responseSchema` set to a structured JSON
  schema requiring:
  - `agents`: array of `{ name: string, persona: string, theme: string }`
    (all three required per item).
  - `initialTask`: `{ targetAgent: string, prompt: string }` (both required).
- **On success:** the raw response text is `JSON.parse`d (a parse failure —
  e.g., the model returning non-conforming text — is caught, see Failure
  below). Each `agents[]` entry is added via the **same** alphanumeric-name
  sanitization as 6.1, additively (existing agents in the directory are
  never removed or overwritten by this path unless an existing agent
  happens to share the sanitized name — see the 6.1 collision note: this
  path assigns unconditionally without an existence check). Each generated
  agent respects `MAX_AGENTS` individually — an agent that would exceed the
  cap is skipped (logged) while agents already under the cap still get
  created. After all agents are processed: the manual task-prompt field is
  pre-filled with `initialTask.prompt`, and the manual task-target dropdown
  is set to `initialTask.targetAgent` (sanitized the same way) if that
  agent exists in the directory, otherwise it falls back to whatever agent
  is first in the directory's `agents` object — the task is **not**
  automatically enqueued; the user must submit it manually. State is
  persisted (`persistState()`) after a successful run.
- **Failure:** a thrown error at any step (Gemini call exhausts retries,
  non-JSON or schema-violating response, etc.) is caught, logs
  `"Failed to generate architecture: <message>"` to the SYSTEM console feed,
  and shows an "Architecture generation failed." toast. No partial agents
  from a failed run are added (the `forEach` that creates agents only runs
  after a successful parse). The trigger button is re-enabled and its label
  restored in a `finally` block regardless of outcome.

### 7.9 Directory export / import

Client-side-only JSON backup/restore, via the Export/Export-All/Import
buttons in the Directory switcher pill (header). Both export shapes share
one `<input type="file">`, and Import auto-detects which shape it received.

- **Export current directory** (`exportCurrentDirectory`): commits any
  pending in-memory changes (`saveCurrentWorkspaceState()`), then downloads
  a JSON file named `<sanitized-directory-name>.agentlooper.json` (via a
  `Blob` + `URL.createObjectURL` + a synthetic `<a download>` click — no
  server round-trip) shaped as:
  ```json
  {
    "agentlooperExport": 1,
    "directoryName": "<current directory name>",
    "exportedAt": "<ISO-8601 timestamp>",
    "directory": { "agents": {...}, "taskQueue": [...], "positions": {...}, "completedTasksCount": 0, "mockGDriveFiles": [...] }
  }
  ```
  `directory` is exactly the 6.3 Directory shape.
- **Export full backup** (`exportAllDirectories`): commits pending changes,
  then downloads `agentlooper-backup-<ISO-timestamp-with-colons-as-dashes>.json`
  shaped as:
  ```json
  {
    "agentlooperExport": 1,
    "kind": "backup",
    "exportedAt": "<ISO-8601 timestamp>",
    "currentWorkspace": "<name active at export time>",
    "workspaces": { "<directoryName>": { ...Directory shape... }, "...": {} }
  }
  ```
  containing every directory in `workspaces`, unmodified.
- **Import** (`handleImportFile`, wired to a hidden `<input type="file"
accept=".json">`): reads the selected file as text and `JSON.parse`s it,
  then dispatches on shape:
  - Invalid JSON syntax → toast "Import failed: not valid JSON.", no state
    change.
  - A top-level `directory` object present → **single-directory import**:
    validated (`directory.agents` must be an object, `directory.taskQueue`
    must be an array — otherwise toast "Import failed: not a recognized
    AgentLooper directory export." and no state change) and landed under a
    new directory named after `directoryName` (falling back to
    `"Imported Directory"` if absent/blank).
  - Else a top-level `workspaces` object present → **full-backup import**:
    every entry in `workspaces` is validated and landed the same way as a
    single-directory import, one at a time; entries that fail validation
    are skipped individually rather than aborting the whole import. If
    _none_ validate, toast "Import failed: backup file contained no valid
    directories." and no state change.
  - Neither shape present → toast "Import failed: not a recognized
    AgentLooper export file.", no state change.
  - **Landing a directory** (shared by both paths): the name is
    disambiguated against existing `workspaces` keys by appending an
    incrementing suffix — `"<name> (Imported 2)"`, `"(Imported 3)"`, etc. —
    so an import **never** overwrites the current or any existing
    directory. Any task queue entry with `status: "processing"` is reset to
    `"pending"` (same fixup as normal boot restore, 6.4); a `"failed"` entry
    stays `"failed"`. Missing optional fields (`positions`,
    `completedTasksCount`, `mockGDriveFiles`) are defaulted the same way a
    brand-new directory would be (6.3's defaults / `0` / `[]`), so a
    hand-edited or partial file still imports.
  - **Post-import switch:** if no task in the _current_ directory is
    `status: "processing"`, the app switches to the imported directory (for
    a backup with multiple directories: to whichever one the backup's own
    `currentWorkspace` landed as, if it didn't collide, otherwise the first
    directory landed) and shows a success toast naming what was imported.
    If a task **is** processing, the import still succeeds (directories are
    created and persisted) but the app stays put, with a toast explaining
    the user must switch manually once the active task finishes.
  - `persistState()` runs at the end of either path, so imported
    directories survive a reload immediately.

## 8. Non-functional requirements

- **No backend / no server-side secrets.** The entire app is static
  (`index.html` + assets); the OAuth client ID is public by design, no
  client secret is ever used or stored.
- **Deployment:** pushing to the default branch auto-deploys to GitHub
  Pages via `.github/workflows/pages.yml`; the "build" is a direct upload of
  the repository contents (minus `.git`/`.github`).
- **Browser/runtime requirements:** requires a secure context (HTTPS or
  `localhost`) — both Google Identity Services sign-in and the app's use of
  `crypto.randomUUID()` (task queue entry ids) require one; it will not
  function correctly (sign-in cannot work, and depending on the browser
  `crypto.randomUUID` may be unavailable) when opened via `file://`.
  Supported/tested browsers: the latest stable release of Chrome, Edge,
  Firefox, and Safari on desktop Windows/macOS/Linux. No support for
  Internet Explorer or legacy (pre-Chromium) Edge. Sandbox mode has no
  server-communication requirement and works from any origin, including
  `file://`, on the same browser set.
- **Accessibility:** no WCAG or other conformance target is set for this
  iteration (explicit non-goal, 3); the UI carries some incidental ARIA
  attributes but they are not tested against a standard.
- **Multi-tab/window:** unsupported. There is no cross-tab locking,
  `BroadcastChannel`, or `storage`-event listener — if the same directory is
  open and mutating state in two tabs, whichever tab's `persistState()`
  (triggered by `beforeunload` or a mutating action) writes to
  `localStorage` last wins; the other tab's in-memory changes since the last
  write are silently lost on its own next persist.
- **Security — OAuth client ID exposure:** the client ID embedded in
  `index.html` is intentionally public (Google's model for browser-only
  OAuth apps); the only controls against misuse are Google's
  Authorized-JavaScript-Origins restriction on that client ID and the
  scopes granted per-user at consent time. There is no server-side rate
  limiting layer — Gemini/Workspace API quota enforcement is entirely
  Google's.
- **Single-file architecture:** all markup, styles, and logic live in
  `index.html`; changes should stay small and reviewable given the lack of
  module boundaries. No JS framework, bundler, or build step is permitted —
  all logic ships as plain `<script>` tags inside `index.html`, executed
  directly by the browser with no compile/transpile stage.
- **XSS safety:** dynamic/user-derived content must use delegated event
  handlers, not inline `onclick="..."` strings, per the existing
  `wireDelegatedClickHandlers` convention; agent/user-supplied names are
  alphanumeric-sanitized (6.1) before being used as object keys or DOM ids
  for this reason.
- **Linting:** `npm run lint` (HTML structural lint via `@html-eslint`) must
  pass in CI on every push/PR.
- **Performance:** no numeric performance target is set — this is a
  deliberate decision, not a gap. The scheduler runs at most one task at a
  time by design (7.1), so throughput is bounded by Gemini response latency,
  not the app. The only bound worth naming explicitly: worst-case time for a
  single task to fail via retry exhaustion is on the order of
  1s+2s+4s+8s+16s ≈ 31s of backoff sleep (5 retries, 1000ms base, doubling)
  plus request time, before the task-failure path in 7.1 takes over — there
  is no shorter timeout imposed on top of that.

## 9. Acceptance criteria

One or more pass/fail criteria per functional requirement in Section 7.
Given/When/Then form is used where a specific trigger and outcome are
testable.

**Agent orchestration and task failure (7.1)**

1. Given a directory with 39 agents, when a `[CREATE_AGENT]` tag or the
   manual form registers a 40th, then it succeeds; a 41st attempt by either
   path is rejected and a SYSTEM error log line containing "Agent cap (40)"
   appears, with no new entry added to `agents`.
2. Given an agent name containing only non-alphanumeric characters (e.g.
   `"!!!"`), when creation is attempted via any path, then no agent is
   created and (for the manual form) a toast reading "Agent name must
   contain at least one letter or number." is shown.
3. Given an agent id that already exists, when `[CREATE_AGENT]` targets that
   same id, then the existing agent's fields are unchanged and a SYSTEM log
   line reading "Agent '<id>' already registered. Skipping dynamic spawn."
   appears.
4. Given a `[TRIGGER_AGENT: name="Ghost", ...]` tag where `Ghost` does not
   exist and the directory is under the agent cap, then a new agent with id
   `Ghost` is created with the fallback clone persona, and a `once` task to
   it is enqueued.
5. Given a `[SCHEDULE_LOOP: name="Ghost", ...]` tag where `Ghost` does not
   exist, then no agent is created, no task is enqueued, and a SYSTEM log
   line reading "Loop target 'Ghost' missing. Loop scheduling skipped."
   appears.
6. Given a `once` task whose `callGemini` call ultimately throws (e.g., 5
   consecutive 500s), when the scheduler tick catches it, then the task's
   `status` becomes `"failed"`, `error` holds the thrown message, the task
   remains in `taskQueue`, `completedTasksCount` does not increment, and no
   entry is added to the target agent's `memory`.
7. Given a `loop` task not on its last iteration whose iteration throws,
   then `status` returns to `"pending"` for the next iteration,
   `currentIteration` still advances, `lastError` is set to the thrown
   message, and the loop is not stopped.
8. Given a `loop` task ON its last iteration (`currentIteration ===
maxIterations`) whose iteration throws, then `status` becomes `"failed"`
   (not removed, not completed) exactly like criterion 6, and
   `completedTasksCount` does not increment.
9. Given a task with `status: "failed"`, when its Retry control is clicked,
   then `status` becomes `"pending"`, `scheduledTime` is set to now, `error`
   is cleared, and the scheduler picks it up on its next due tick.
10. Given a task with `status: "failed"`, when its dismiss (✕) control is
    clicked, then the task is removed from `taskQueue` (same code path as
    aborting any other task).
11. Given the same task fails, is retried, and succeeds, then its final
    state is indistinguishable from a task that succeeded on the first
    attempt (removed from the queue, `completedTasksCount` incremented,
    `memory` updated).

**Safety caps (7.2)**

12. Given a directory at 60 queued tasks, when any tag or UI action attempts
    to enqueue a 61st, then it is rejected with a logged/toasted "queue is
    full (60)" message and the queue length remains 60.
13. Given `[SCHEDULE_LOOP: ..., interval_sec="1", limit="9999", ...]`, when
    parsed, then the resulting entry has `intervalSec: 5` and
    `maxIterations: 20`.
14. Given more than 200 console blocks have been logged, then the oldest
    entries are removed from the DOM such that exactly 200 remain.
15. Given a directory with 60 queued tasks, 10 of which are `status:
"failed"` and undismissed, then a new enqueue attempt is still rejected
    (failed tasks count toward `MAX_QUEUE` until dismissed or retried).

**Google Workspace integration (7.3)**

16. Given a user unchecks the `cloud-platform` scope checkbox at Google
    consent, when sign-in completes, then a toast, a SYSTEM console log
    line, and a `console.warn` call all fire, each referencing the missing
    scope.
17. Given a valid session token, when any Workspace/Gemini API call returns
    HTTP 401 or 403, then `googleAuth.accessToken` is cleared, the
    `sessionStorage` token is removed, the sign-in UI reflects signed-out,
    and the console shows an error instructing the user to sign in again —
    within the same task's failure handling (no separate reauth flow is
    triggered automatically).
18. Given a Gemini call returns HTTP 429 with a `Retry-After: 2` header,
    then the retry occurs after 2 seconds, not the default 1-second/doubling
    schedule.
19. Given sandbox mode (`gDriveMode !== 'real'`) is active, then the model's
    system instruction never includes the Gmail/Calendar/Sheets tag
    documentation block (`workspaceToolsHelp` is empty).

**Human-in-the-loop email gate (7.4)**

20. Given the autonomous-send toggle is off (default) and an agent emits
    `[SEND_GMAIL: to="x@example.com", subject="s", body="b"]`, then a Gmail
    **draft** is created via the API and no message is sent.
21. Given the toggle is explicitly turned on, when the same tag is emitted,
    then the email is sent (not drafted).
22. Given any toggle state, when an agent emits `[DRAFT_GMAIL: ...]`, then a
    draft is always created, never a sent message.

**Persistence (7.5)**

23. Given any directory state (agents, task queue, sandbox files), when the
    page is reloaded, then `workspaces[currentWorkspace]` after reload is
    deep-equal to its value immediately before reload, except that any task
    with `status: "processing"` at save time is `"pending"` after reload.
24. Given no `agentlooper_state_v1` key exists in `localStorage` on boot,
    then a directory named `"Inhalants Directory"` is created and seeded
    with the `band` preset's agents.

**Presets (7.6)**

25. Given the app boots with no persisted state and no other seeding has
    happened yet, then the default directory is auto-seeded with the `band`
    preset's 3 agents (Manager, Booking, Merch).
26. Given a directory already has 1 or more agents, when that directory is
    (re-)loaded via `loadWorkspaceState` (boot restore or directory switch),
    then no preset agents are auto-seeded into it (the directory's agent set
    is unchanged by this path).
27. Given a directory with any existing agents and/or queued tasks (none
    `processing`), when the user clicks "Band Manager" or "Code Generation"
    in the Starter Presets panel, then the directory's `agents` and
    `taskQueue` are fully replaced with the chosen preset's 3 agents and an
    empty queue, the console feed is cleared, the task-prompt field and
    task-target-agent select reflect the preset's `initialTask`, and a
    "Loaded preset environment: `<band|code>`" toast appears.
28. Given a task in the directory has `status: "processing"`, when a Starter
    Presets button is clicked, then the load is rejected with the
    "Clear active running tasks..." toast and neither `agents` nor
    `taskQueue` are modified.

**Directory lifecycle (7.7)**

29. Given a directory named `"Foo"` already exists, when a user attempts to
    create another directory also named exactly `"Foo"`, then creation is
    rejected with the "A directory with that name already exists." toast.
30. Given a task in the current directory has `status: "processing"`, when
    the user selects a different directory from the dropdown, then the
    switch is blocked, the dropdown reverts to the current directory, and
    the "Cannot switch workspaces..." toast is shown.
31. Given the current directory is renamed to a name that doesn't collide
    with any existing directory (including while a task is `processing`),
    then `workspaces` no longer has the old key, a new key with the new name
    holds the identical `agents`/`taskQueue`/`positions`/etc., and
    `currentWorkspace` equals the new name.
32. Given the current directory is renamed to a name that already exists,
    then the rename is rejected with the "A directory with that name
    already exists." toast and `workspaces` is unchanged.
33. Given more than one directory exists and none has a `status:
"processing"` task, when the user deletes the current directory and
    confirms the browser dialog, then that key is removed from `workspaces`
    and the app switches to one of the remaining directories.
34. Given only one directory exists, when delete is attempted, then it is
    rejected with the "Cannot delete the only remaining directory." toast
    and `workspaces` is unchanged.
35. Given a task in the current directory has `status: "processing"`, when
    delete is attempted, then it is rejected with the "Cannot delete a
    directory while an agent task is active." toast and `workspaces` is
    unchanged.

**Non-functional requirements (8)**

36. Given the app is opened via `file://` instead of `http(s)://`, then
    Google sign-in fails to complete (Google Identity Services requires a
    secure context) while sandbox mode (no sign-in, no `[SEND_GMAIL]`/
    `[CREATE_EVENT]`/etc. tags advertised) remains fully usable.
37. Given the latest stable release of Chrome, Edge, Firefox, or Safari on
    desktop Windows/macOS/Linux, then the app loads and sandbox mode is
    fully functional with no console errors on boot; no other browser is a
    supported target.
38. Given the same directory open in two browser tabs, when both tabs
    mutate state and both eventually fire `persistState()` (e.g., via
    `beforeunload`), then `localStorage["agentlooper_state_v1"]` reflects
    only the last tab to write — the other tab's unsaved-at-that-point
    changes are gone, with no error surfaced to either tab.
39. Given the repository as checked out, then no `package.json` build/compile
    script is required to run the app — `index.html` is directly loadable by
    a browser (via `npm run dev`'s static file server or any other static
    server) with zero transpilation step.
40. There is no accessibility audit, WCAG-conformance check, or automated
    a11y test in CI — verifiable by absence from `.github/workflows/ci.yml`
    (only `npm run lint` runs there).

**AI Architect ecosystem builder (7.8)**

41. Given an empty goal string, when the "Autogenerate Ecosystem" action is
    triggered, then no Gemini call is made and a toast reading "Please
    describe what ecosystem you want to build." is shown.
42. Given a valid goal and a directory with 38 existing agents, when Gemini
    returns 4 agents in its structured response, then 2 are created (filling
    the cap to 40) and 2 are skipped with a logged agent-cap error each —
    the run as a whole still reports success (the toast and prompt-prefill
    still occur) since the top-level call succeeded.
43. Given Gemini returns text that fails `JSON.parse`, then zero agents are
    added to the directory, a SYSTEM log line prefixed "Failed to generate
    architecture:" appears, an error toast is shown, and the trigger button
    is re-enabled with its original label.
44. Given a successful run whose `initialTask.targetAgent` (after
    sanitization) does not match any agent actually created this run or
    already present, then the task-target dropdown falls back to the first
    agent in the directory's `agents` object, and no task is auto-enqueued
    in either case — the user must submit the pre-filled prompt manually.

**Directory export/import (7.9)**

45. Given any directory, when Export is clicked, then a file named
    `<sanitized-name>.agentlooper.json` downloads containing
    `agentlooperExport: 1`, the directory name, an ISO timestamp, and a
    `directory` object deep-equal to `workspaces[currentWorkspace]` at
    export time.
46. Given a file that isn't valid JSON, when it's selected for Import, then
    a "not valid JSON" error toast appears and no directory is added to
    `workspaces`.
47. Given valid JSON lacking both a `directory` object and a `workspaces`
    object at the top level, when selected for Import, then a "not a
    recognized AgentLooper export file" error toast appears and no
    directory is added.
48. Given a valid single-directory export file whose `directoryName`
    matches an existing directory, when imported, then a new directory
    named `"<name> (Imported 2)"` is created (incrementing further on
    repeated collisions) rather than overwriting the existing one.
49. Given a valid export file containing a task with `status: "processing"`,
    when imported, then that task's status is `"pending"` in the new
    directory immediately after import; a task with `status: "failed"`
    stays `"failed"`.
50. Given no task in the current directory is `status: "processing"`, when a
    valid single-directory file is imported, then the app switches to the
    newly created directory and shows an "Imported..." toast; given a task
    **is** `status: "processing"`, the import still creates the directory
    but the app stays on the current one, with a toast saying to switch
    manually once the active task finishes.
51. Given 3 directories exist, when "Export Full Backup" is clicked, then a
    file named `agentlooper-backup-<timestamp>.json` downloads containing
    `kind: "backup"`, a `workspaces` map with all 3 directories, and a
    `currentWorkspace` string matching the directory active at export time.
52. Given a valid backup-shaped file (top-level `workspaces` map) is
    selected for Import, then every directory inside it is landed under a
    unique name (suffixed on collision, same rule as single-directory
    import) and one combined "Imported N director(y/ies) from backup" toast
    appears — not one toast per directory.
53. Given a backup file whose `currentWorkspace` matches the name one of its
    directories landed under (no collision), then the app switches to that
    directory after import (subject to the same processing-task guard as
    criterion 50); otherwise it switches to the first successfully-imported
    directory.
54. Given a backup file where some directory entries are valid and others
    are malformed (missing `agents`/`taskQueue`), when imported, then the
    valid entries are still landed and switched-to/toasted normally, and the
    malformed entries are silently skipped (not counted, no partial/broken
    directory created for them).

## 10. Out of scope / known limitations

- No collaboration or sharing of a directory between multiple users/browsers
  beyond manually sending someone an exported `.json` file.
- No cross-device sync (state lives in one browser's `localStorage`); Export/
  Import (7.9) is the closest thing to a portability mechanism, and it's a
  manual, one-shot file transfer, not sync.
- No audit log/export of agent actions beyond the in-session console feed
  (capped at 200 entries, DOM-only, not persisted) and whatever artifacts
  land in Drive/Gmail/Calendar/Sheets themselves.
- No automatic retry or expiry of a `status: "failed"` task — it sits in the
  queue (counting against `MAX_QUEUE`) until the user manually retries or
  dismisses it (7.1).
- Single LLM provider (Gemini) and one hardcoded model
  (`gemini-2.5-flash-preview-09-2025`), changed only by editing source.
- No multi-tab support (8).
- No "restore over itself" import — a re-imported file always lands as a
  new, separate directory rather than overwriting the directory it was
  originally exported from (7.9, Open questions).

## 11. Open questions

- Should safety caps be user-configurable (e.g., power users wanting more
  than 40 agents) or remain fixed constants?
- Should the human-in-the-loop gate extend beyond Gmail to other
  potentially-irreversible actions (e.g., Calendar event creation on a
  shared calendar, Sheet overwrites)?
- Is multi-provider LLM support (beyond Gemini) a future goal, or is the
  Gemini dependency permanent by design?
- Is there a desired path to background/durable execution (e.g., a
  companion worker) or is "stops when the tab closes" acceptable long-term?
- Should re-importing an exported file offer to **overwrite** the directory
  it came from (matched by name) as an alternative to always creating a new
  one, for a "restore this backup over itself" workflow?
- Should a `status: "failed"` task ever auto-expire or auto-dismiss after
  some time/count, or is "accumulates until the user acts" acceptable given
  it already counts against `MAX_QUEUE` as a natural pressure valve?
- Should Retry support an automatic backoff/retry-N-times mode, or is
  one-attempt-at-a-time (current behavior) the intended level of manual
  control?
