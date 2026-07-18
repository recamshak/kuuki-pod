# kuuki-pod webapp

Backend-less browser dashboard for the Pod. It connects to a Pod over Web
Bluetooth, Syncs buffered Samples, Merges them into a per-Pod History in
localStorage, and shows the current CO₂ (from the Live reading) plus a
timeseries. See `../CONTEXT.md` for the domain vocabulary,
`../docs/specs/0001-kuuki-pod-v1.md` for the spec, and
`../docs/adr/0004-webapp-tech-stack.md` for the stack rationale.

This is the v1 skeleton: it loads in a browser and renders a banner. The
Connect button, CO₂-hero, timeseries chart, and the Sync/Merge logic arrive in
later tickets. Stack: plain Svelte 5 (runes) + Vite + TypeScript, tested with
Vitest.

## Prerequisites

Node and npm (`node --version`). Install dependencies once:

```sh
npm install
```

## Run the unit-test suite

```sh
npm test
```

Runs every `src/**/*.test.ts` suite once via Vitest and exits green. The runner
uses the `node` environment — **no browser, no Web Bluetooth, no DOM** — so the
correctness-critical seams (the slot-keyed `applySync` Merge and the wire-record
decoder, added in later tickets) are TDD'd in fast isolation. `src/lib/smoke.ts`
+ `smoke.test.ts` are the reference pattern.

Web Bluetooth transport and Svelte UI rendering are out of unit-test scope
(verified manually on-device / in a browser), per the spec's testing decisions.

## Run the dev server

```sh
npm run dev
```

Serves the app with hot-reload. Web Bluetooth requires a secure context; on
`localhost` the dev server qualifies.

## Type-check

```sh
npm run check
```

## Build the installable site

```sh
npm run build
```

Emits a static `dist/` (relative-path assets, so it hosts under a GitHub Pages
subpath) plus the web app manifest for installability. Preview it with
`npm run preview`.
