# `cvx replay`

Runs an app or its tests against a recording instead of its real dependencies.

```bash
cvx record -- npm start      # use the app; its database calls are captured
cvx replay -- npm test       # same app, no database, no cache, no network
```

## How the app is redirected

`cvx record` rewrote `DATABASE_URL` and `REDIS_URL` to point at recording
proxies. `cvx replay` rewrites the same variables to point at servers that
answer from the recording. Nothing in the app changes.

Which servers start is decided by the recording, not the environment — the
machine running the tests usually has no `DATABASE_URL` at all, which is the
point of the feature.

## An unrecorded call is an error, never an empty result

This is the single most important decision in this directory.

A `GET` that returns nil, or a `SELECT` that returns zero rows, is a *plausible*
answer. If a mock gives a plausible answer to a query nobody recorded, a real
regression becomes a passing test — the worst outcome a mocking tool can
produce. Both replay servers return a protocol-level error instead, and the
summary names every statement that had no recording.

## Fidelity

| Preserved | How |
|---|---|
| Column types | The recorder keeps each column's type OID, so a driver returns `1` rather than `"1"` |
| SQL NULL | Length `-1` stays null rather than collapsing to `""` |
| Redis nil | `$-1` stays null rather than collapsing to `""` |
| Repeated calls | Answered in recorded order, so a counter replays 1 then 2 |

Past the end of a recorded sequence the last value repeats, so an app that
polls more times than the recording saw keeps the value it last had instead of
falling off into an error.

## Matching

Postgres prefers an exact SQL-and-parameters match and falls back to the SQL
alone. The fallback exists because an app replayed against a recording often
binds an id it generated during this run; failing on that value would make most
recordings unusable.

## Protocols

Postgres, Redis and MongoDB. MongoDB's handshake is synthesised rather than
replayed — a driver issues no queries at all until it has negotiated a wire
version, so a server that only knows how to answer `find` never gets asked.

## Divergence is reported, not hidden

Two things a recording cannot do, and neither can be fixed without becoming a
database:

- **Writes do not affect later reads.** An `INSERT` replays its recorded tag; it
  does not change what a later `SELECT` returns.
- **Non-determinism.** `NOW()`, `RANDOM()`, sequences and `RETURNING id` replay
  the value they returned during recording.

`divergence.ts` watches for both and names the statements involved in the
summary. A replay serving a stale row looks exactly like a passing test; a
replay that says "this SELECT reads users after this run wrote to it" is
something a developer can act on.
