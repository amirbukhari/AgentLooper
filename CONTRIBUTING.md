# Contributing

Thanks for your interest in AgentLooper! It's a small, single-file static app, so
the workflow is deliberately lightweight.

## Getting set up

```bash
npm install
npm run dev
```

## Before you open a PR

- Run `npm run lint` — it must pass (CI enforces this).
- Keep changes to `index.html` focused; it's one file, so small, reviewable diffs
  matter. Avoid reformatting the whole file in an unrelated change.
- If you touch tooling or docs (not `index.html`), run `npm run format` so the
  config/markdown files stay consistent.

## Conventions

- Prefer delegated event handlers over inline `onclick="..."` strings for anything
  built from dynamic/user data — inline handlers are XSS-prone. See the existing
  `wireDelegatedClickHandlers` pattern.
- Never commit an OAuth **client secret**. The client ID in the page is public by
  design; secrets are not part of this browser-only flow.

## Reporting issues

Open a GitHub issue with steps to reproduce, the browser you used, and whether you
were in sandbox or real-Drive mode.
