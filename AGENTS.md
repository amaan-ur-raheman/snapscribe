# SnapScribe

On-device screenshot capture for Chrome (Manifest V3). Capture the visible
area, full page, region, or a specific element, then export to PNG, JPEG, or
PDF. All processing happens in the browser — nothing leaves the machine.

## Development

- Runtime: [Bun](https://bun.sh) (>= 1.3). Install deps with `bun install`.
- Build tooling: Vite + `@crxjs/vite-plugin` (bundles the MV3 manifest and
  provides HMR). Output goes to `dist/` — load it unpacked at
  `chrome://extensions` with Developer mode enabled.
- TypeScript in strict mode; `noUncheckedIndexedAccess` is on, so indexing
  returns `T | undefined` and must be handled.

| Command                | What it does                    |
| ---------------------- | ------------------------------- |
| `bun run dev`          | Start Vite dev server with HMR  |
| `bun run build`        | Typecheck, then produce `dist/` |
| `bun run typecheck`    | `tsc --noEmit` (strict)         |
| `bun run lint`         | ESLint (flat config)            |
| `bun run lint:fix`     | ESLint with `--fix`             |
| `bun run format`       | Prettier — write formatting     |
| `bun run format:check` | Prettier — verify formatting    |
| `bun run icons`        | Regenerate extension icons      |

## Architecture

- `src/background/service-worker.ts` — capture + export orchestration; the
  only place that talks to `chrome.tabs` / `chrome.downloads`
- `src/content/` — page overlays (region / element capture)
- `src/popup/` — toolbar popup UI
- `src/editor/` — post-capture editor (crop, annotate, redact)
- `src/options/` — settings page
- `src/lib/` — PDF encoder, full-page stitcher, typed storage wrapper
- `src/types/messages.ts` — discriminated union of every runtime message;
  all `sendMessage` / `onMessage` calls are typed through it

## Agent skills

### Issue tracker

Issues for this repo live as GitHub issues, managed via the `gh` CLI.
See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage` / `needs-info` /
`ready-for-agent` / `ready-for-human` / `wontfix`.
See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one `CONTEXT.md` + `docs/adr/` at the repo root.
See `docs/agents/domain.md`.
