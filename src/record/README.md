# `cvx record`

Turns a running app into a test suite by using it. This is the capability
Keploy is known for, built so it runs where Keploy cannot.

## Why not eBPF

Keploy captures traffic with eBPF probes on syscalls, which needs Linux 4.15+,
root, and a cooperating kernel. That rules out every developer on macOS or
Windows, most CI runners, and anything containerised without privileges.

Two proxies and two long-standing environment conventions get the same
request/response pairs with nothing but a socket:

```
  your traffic ──► ingress proxy :3000 ──► your app :3001      → test cases
  your app ──────► egress proxy :16789 ──► real downstream     → mocks
```

The app is moved to `PORT + 1` — every mainstream framework honours `PORT` —
so the recorder can take the address the developer was already using. Existing
curl commands, browser tabs and frontend configs keep working untouched.

## Files

| File | Responsibility |
|---|---|
| `exchange.ts` | The captured pair, and its HAR 1.2 serialisation |
| `ingressProxy.ts` | Reverse proxy in front of the app; produces test cases |
| `egressProxy.ts` | Forward proxy for outbound calls; produces mocks |
| `nodeProxyShim.ts` | Preload that makes Node's `http` respect the proxy |
| `bodyBuffer.ts` | Bounded body capture |
| `session.ts` | Spawns the app, wires the environment, writes the recording |

## Output is HAR, deliberately

The server already turns a HAR into a suite with assertions and a mock set
(`app/routes/import_export.py`, `app/importers/har_assertions.py`). Emitting a
second format would have meant a second importer and two sets of bugs. Every
field written by `exchange.ts` is one that importer actually reads — notably
`response.content.mimeType`, which gates the static-asset filter, and
`postData.mimeType`, which the importer compares against `application/json`
exactly and so must not carry a `charset` parameter.

## Two limits, stated rather than hidden

**HTTPS egress is not recorded.** A CONNECT tunnel is opaque without an
interception certificate. Those hosts are counted and named in the summary
instead of being silently dropped — a recorder that reports a clean zero for
traffic it could not see is worse than one that fails loudly.

**Node needs the shim.** Go, Python, curl and axios all read `*_PROXY` from the
environment. Node's `http` module ignores it entirely, so an unpatched Node app
records a clean-looking session with every dependency call missing. The shim is
preloaded via `NODE_OPTIONS` and rewrites outbound requests through the proxy;
it must patch `http.get` as well as `http.request`, because `get` calls the
module-local `request` rather than the exported one.

## No account required

Recording is entirely local — nothing leaves the machine — and the command does
not call `resolveConfig`. That is deliberate: every other `cvx` command throws
without an API key, and a tool that demands an account before it will show you
anything is one most people never evaluate at all.
