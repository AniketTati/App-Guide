# App Guide for Mac

The desktop app for a product manager who owns an agent-built product and never
opens a terminal: what is waiting on them, the work Claude has in flight, and a
Check of each branch against main before it merges. The plan and its gates are
in [../docs/notes/pm-app.md](../docs/notes/pm-app.md).

## Build and install

Once, by whoever keeps the app up to date:

```bash
pnpm install
pnpm run package
```

That builds the app, signs it for this Mac only, and puts it in
`~/Applications/App Guide.app`. The first time it reads a repository under
`~/Documents`, macOS asks once whether it may. Everything it remembers is in
`~/Library/Application Support/App Guide/`.

## Develop

```bash
pnpm build
APPGUIDE_DEV_PROJECT=/path/to/repo node dist/devserver.cjs
pnpm dev:renderer
pnpm test
```

The first command after `pnpm build` starts a read-only API on
`127.0.0.1:5198` for one repository. The next serves the page at
`http://localhost:5199`, so every screen can be run and checked in a browser.

## How it is put together

| | |
|---|---|
| `src/main` | the window, what the app remembers, notifications. It never reads a repository itself. |
| `src/worker` | a utility process that reads repositories, using the engine in `../src` |
| `src/core` | engine results turned into views, in the PM's words |
| `src/renderer` | the page (React) |
| `src/shared/api.ts` | every call the page can make: ids in, views out |
| `src/dev` | the read-only development server |
