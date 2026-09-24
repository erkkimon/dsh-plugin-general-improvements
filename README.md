# dsh-plugin-general-improvements

General improvements to the [DeepSeek Harness](https://github.com/deepseek-ai/dsh)
Web GUI, collected in one plugin. Each improvement is independent; the plugin
is a home for small fixes that are not worth a package of their own.

## 1. Sidebar attention marks

Out of the box the workspaces sidebar shows a spinner while an agent is
working and a dot when a turn completed unread. But when the model errors out
(quota exhausted, network failure, a provider 5xx), a hook blocks the turn,
the host stops mid-turn, or the model hits its token limit, the row simply
goes back to looking idle. The failure is silent, and the task quietly never
gets done.

This plugin adds:

- **An `!` badge** (exclamation mark in a ring) on a session row whose last
  turn ended abnormally — `turn/end` reason `error`, `interrupted`, `blocked`,
  `max-tokens`, or an `aborted` that the user or parent agent did not ask for.
  Hover the row to read the error. The mark **never disappears on its own**,
  and because it is folded from the session log it also covers failures that
  happened while no browser was open.
- **A right-click menu** on every session row (grouped tree, flat list and
  search results):
  - **Mark as cleared** — removes the badge, until the *next* failure.
  - **Mark as unread** / **Mark as read** — a manual dot, for a conversation
    you want to come back to. It survives reloads and clears when you open
    the session again or choose *Mark as read*.
  - **Copy session id**.

Precedence per row: running spinner › `!` error badge › unread dot › the
shipped state.

### Accessible by construction

The two states differ by **shape** first — `!` in a ring versus a filled dot —
so nothing depends on telling red from green. (The default palette's error and
success colours are exactly that pair, which is the most common form of colour
vision deficiency; a red dot and a green dot are the same dot to a sizeable
share of users.) Colour is only a redundant second cue, every mark carries a
`title` in words, and marked rows expose screen-reader text. The marks stay
legible in greyscale.

### How it works

- **Host half** registers the `improvementsAttention` session projection,
  which folds `turn/end` events and rides the ordinary projection wire, so
  every listed session carries its state live — not just the open one. It
  also serves:
  - `GET /general-improvements/state` — manual flags plus attention state,
    including sessions that are not attached (those are folded on demand,
    because the durable projection cache only serves keys a checkpoint has
    already written).
  - `POST /general-improvements/flags/<sessionId>` — body `{ clear: true }`
    and/or `{ unread: boolean }`.

  Manual flags are stored in
  `$DSH_HOME/storages/general-improvements/session-flags.json`.
- **Client half** watches the sidebar, resolves each rendered row back to its
  session id, and tags it with `data-dsh-imp="error|unread"`; a small
  stylesheet draws the mark as a CSS shape. It also listens to
  `api-session/error` so a live failure is marked immediately.

## Requirements

DeepSeek Harness `0.1.2-rc.1` or compatible, on a web profile. The plugin
reads only session metadata and its own flag file; it sends nothing anywhere.

## Install

From the npm registry:

```sh
dsh plugin --profile web add dsh-plugin-general-improvements
```

or from a local checkout:

```sh
dsh plugin --profile web add link:/path/to/dsh-plugin-general-improvements
```

Either way the package ships a bundle self-activation patch, so it is
registered automatically. Restart the web surface afterwards.

> **One registration per plugin.** If your profile is managed centrally (for
> example by a configuration-management role that renders its own `insert`
> row into the profile's `cordis.patch.yml`), do **not** let it be registered
> twice: the loader treats a duplicate entry id as fatal, the process exits at
> boot, and anything proxying it returns 502. Note that `dsh plugin add` and
> `dsh plugin remove` re-derive `dsh.profile.bundles` from `dependencies` on
> every run, appending any package that declares `dsh.bundle` — so on a
> centrally managed profile, register it in exactly one place.

To register it by hand instead, add to a profile patch:

```yaml
- insert:
    - id: general-improvements
      name: dsh-plugin-general-improvements
```

## Development

The plugin is plain JavaScript with no build step. The host half is ESM
(`lib/index.js`); the client half (`lib/client.js`) is loaded by the Web
shell's module loader and shares the shell's React.

```sh
node --check lib/index.js && node --check lib/client.js
```

## License

MIT
