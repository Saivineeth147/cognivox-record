# @cognivox/record

Turn a running app into a test suite by using it. Then run it again with no database.

```bash
npx @cognivox/record record -- npm start    # use your app; Ctrl-C when done
npx @cognivox/record replay -- npm test     # same app — no Postgres, no Redis, no MongoDB
```

No account. No eBPF, no root, no kernel modules. macOS, Windows and Linux.

## What it records

| Traffic | Mechanism | Becomes |
|---|---|---|
| Requests to your app | Your app moves to `PORT+1`; the recorder takes the port you already use | Test cases (HAR) |
| Outbound HTTP | `HTTP_PROXY`, honoured by curl, Python, Go, axios; a preload shim for Node's `http` | Mocks |
| Outbound HTTPS | A local CA, trusted only by the processes this launches; TLS is terminated and re-originated | Mocks |
| Postgres, Redis, MongoDB | `DATABASE_URL` / `REDIS_URL` / `MONGODB_URI` rewritten to a proxy that decodes the wire protocol | Mocks (`dependencies.json`) |

Existing curl commands, browser tabs and frontend configs keep working unchanged — the recorder sits on the port you were already using.

## What it decodes

- **Postgres** — the simple protocol and the extended one every real driver uses (`Parse`/`Bind`/`Execute`), so parameterised statements record with their bound values. Column type OIDs are preserved: a replayed `1` is a number, not `"1"`. `sslmode=require` is followed through its in-band TLS upgrade.
- **Redis** — RESP2, pipelining included.
- **MongoDB** — `OP_MSG` and the `OP_QUERY` handshake drivers open with. BSON codec verified against the official driver in both directions.

## Replay refuses to guess

**An unrecorded call returns an error, never an empty result.** Nil for a `GET`, zero rows for a `SELECT`, an empty cursor batch — those are *plausible* answers, and a plausible wrong answer turns a real regression into a passing test. Every call with no recording is named in the summary.

Repeated calls replay in recorded order: a counter that returned 1 then 2 replays as 1 then 2.

## Where replay differs from a real database

Two things a recording cannot do, and neither can be fixed without becoming a database:

- A write performed during replay does not change what a later read returns.
- `NOW()`, `RANDOM()`, sequences and `RETURNING id` return what they returned during recording.

Rather than hide either, the summary names each statement affected.

## Why this is open source

This code installs a certificate authority and terminates your app's TLS. You should be able to read it before you run it.

What it does *not* do — generate assertions, run suites in CI, diff responses, drive a browser — lives in [Cognivox](https://cognivox-ai.com), where recordings import with one command.

## Security properties

- CA private key written `0600` under `~/.cognivox/ca/`, reused across runs, **never installed into a system or browser trust store**
- Trust is scoped to the child process through `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, and disappears when it exits
- Those bundles contain the system roots *plus* the recording CA — recording never narrows what your app can reach
- Every proxy binds to `127.0.0.1` only
- The upstream side of an HTTPS interception validates the real server's certificate normally
- Hostnames are refused unless they are plain DNS names or IPs

## Limits

- `sslmode=verify-full` and certificate-pinning clients refuse the recording CA; those connections are relayed but not decoded, and named.
- Hardcoded hosts not read from the environment are not captured; the summary lists which variables were rewritten.
- MySQL is not yet decoded.
- Bodies over 2 MB are relayed in full but not retained; the recording carries the true size rather than a truncated body.

## Embedding

```ts
import { runRecordSession, runReplaySession } from '@cognivox/record';
```

Every recorder and replay server is exported. `ProtocolRecorder` is the interface to implement for another wire protocol.

## Requirements

Node 18+. `openssl` on the path for HTTPS and Postgres-TLS capture (present on macOS and Linux; without it those connections are relayed, not decoded, and the summary says so).

## License

MIT — see [LICENSE](./LICENSE).
