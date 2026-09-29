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

## 2. Current time in the model's context

A model has no clock. Left alone it assumes the moment of the first message
still holds, so it keeps saying "good morning" all afternoon, and a chat
resumed the next day carries on in the same morning.

DSH ships an opt-in plugin for this, `@deepseek-ai/dsh-time-context`, which is
mounted in no profile by default. This package's bundle patch mounts it (id
`time-context`, refresh interval 10 minutes). Before a step it adds a durable
message to the session, for example:

```
Time sampled while preparing turn 3, step 1: 2026-09-29T16:49:03+03:00[Europe/Helsinki]
Browser time zone for this request: Europe/Helsinki. Interpret otherwise-unqualified dates and times in this zone.
Elapsed since the preceding model-visible message: 1d 3h 12m 5s.
```

The time zone is the browser's, so it follows a user on a phone abroad. The
"elapsed since the preceding message" line is what makes a resumed chat aware
that the day changed. With a 10 minute refresh interval a long agent run adds
one small message per window instead of one per step, and a resumed chat
always gets a fresh one on its first turn after a pause.

If your profile already registers `@deepseek-ai/dsh-time-context` under
another id, remove the row from `cordis.patch.yml` to avoid running it twice.

## 3. Copy and paste buttons in the composer

Compact buttons sit in the composer's tool row.

- **Share location** (pin) — see improvement 4.
- **Copy message** puts the whole draft on the clipboard (disabled while the
  draft is empty).
- **Paste from clipboard** appends the clipboard text to the end of the draft.
  On a phone the editor is not focused by the paste, so the virtual keyboard
  does not appear and the layout does not jump. That avoids the long-press
  paste menu and its keyboard. If the editor already had focus, it keeps it.

Each button flashes a check mark on success or a tooltip with the reason on
failure. Reading the clipboard needs a secure context (HTTPS or localhost)
and the browser's permission; over plain-HTTP LAN access the paste button
says so. Copy falls back to the legacy `execCommand` path there.

## 4. Who, where and on what network: environment context for the model

The agent gets a short, durable message describing its surroundings:

```
Agent runs as user "erkkimon" on host "ferocitee".
That host is connected to the Wi-Fi network "HomeNet".
User location as reported by the user's mobile browser 3 min ago: 60.1699, 24.9384 (accuracy ±25 m). This is where the user is, not necessarily where the host is.
```

- **User and host name** are always sent (the OS user the DSH process runs as
  and its hostname).
- **Wi-Fi name** is the SSID the *DSH host* is joined to (`iwgetid`, falling
  back to `nmcli`). It is left out when the host has no Wi-Fi radio or is not
  associated, so a wired workstation never says anything false.
  **A web page cannot read the SSID of the phone or laptop it runs on** — no
  browser API exposes it. When the browser supports it, the network *type*
  (`wifi`, `cellular`, `4g`, ...) is passed along instead and labelled as such.
- **Location** is **opt-in**. A pin button in the composer's tool row turns
  sharing on; the browser then asks for its own location permission. While on,
  the position refreshes every 5 minutes while the tab is visible. Click the
  button again to stop and the host forgets the position at once. It needs a
  secure context (HTTPS or localhost); over plain HTTP the button says so.

The message is added when a fact changes (coordinates are compared at about
11 m resolution) and at least every 30 minutes, not on every step. The host
keeps the last report **in memory only** — this plugin never writes it to
disk — and drops it after 12 hours without a refresh. The text goes to
whichever model provider the session uses, like any other context, so turn
location sharing off when that provider should not know where you are.

`GET /general-improvements/context` returns the text the model would be given
right now (and whether a location is on file) — handy for checking.

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
registered automatically (this includes the time-context row of improvement
2). Restart the web surface afterwards.

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
