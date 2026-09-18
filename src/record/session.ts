/**
 * Orchestration for `cvx record`: start both proxies, run the app behind them,
 * and write what was captured.
 *
 * The environment handed to the child is the whole mechanism. `PORT` moves the
 * app one port up so the recorder can take the address the developer already
 * uses, and the `*_PROXY` variables route its outbound calls through the egress
 * recorder. Both are long-standing conventions rather than anything Cognivox
 * invented, which is why this works across languages without an SDK.
 */

import { spawn, ChildProcess } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import type { Server } from 'http';
import { startIngressProxy } from './ingressProxy';
import { startEgressProxy } from './egressProxy';
import { toHar, type RecordedExchange } from './exchange';
import { planRedirects, type RedirectedDependency } from './dependencyEnv';
import { startTcpProxy } from './tcp/recordingTcpProxy';
import { RedisRecorder } from './protocols/redisRecorder';
import { PostgresRecorder } from './protocols/postgresRecorder';
import { MongoRecorder } from './protocols/mongoRecorder';
import type { DependencyInteraction, ProtocolRecorder } from './tcp/protocol';
import {
  ensureCertificateAuthority, isOpensslAvailable, trustEnvironment, trustScope,
  type CertificateAuthority,
} from './tls/certificateAuthority';
import { createHttpsInterceptor } from './tls/httpsInterceptor';
import { startPostgresTlsProxy } from './tls/postgresTlsProxy';

export interface RecordSessionOptions {
  readonly command: readonly string[];
  readonly listenPort: number;
  readonly egressPort: number;
  readonly outputPath: string;
  readonly cliVersion: string;
  /** Where dependency interactions are written, beside the HAR. */
  readonly dependencyPath: string;
  /** First port for the per-dependency proxies. */
  readonly dependencyBasePort: number;
}

/** Protocols we can decode. Anything else is relayed but not recorded. */
const PROTOCOL_RECORDERS: ReadonlyMap<string, () => ProtocolRecorder> = new Map([
  ['redis', () => new RedisRecorder() as ProtocolRecorder],
  ['postgres', () => new PostgresRecorder() as ProtocolRecorder],
  ['mongodb', () => new MongoRecorder() as ProtocolRecorder],
]);

/**
 * How the recorded app finished.
 *
 * These three are genuinely different events and collapsing them into one
 * nullable exit code loses the distinction that matters most: stopping a
 * recording with Ctrl-C is the normal, successful end of a session, while a
 * command that could not be spawned at all recorded nothing for a reason the
 * developer needs told.
 */
export type ChildOutcome =
  | { readonly kind: 'exited'; readonly code: number }
  | { readonly kind: 'signalled'; readonly signal: NodeJS.Signals }
  | { readonly kind: 'failed'; readonly message: string };

export interface RecordSummary {
  readonly ingress: number;
  readonly egress: number;
  readonly opaqueHosts: readonly string[];
  readonly outputPath: string;
  readonly outcome: ChildOutcome;
  /** Interactions captured per dependency, keyed by its environment variable. */
  readonly dependencyCounts: ReadonlyMap<string, number>;
  readonly dependencies: readonly RedirectedDependency[];
  readonly dependencyPath: string | null;
  /** True when TLS could be read; false when openssl was unavailable. */
  readonly tlsIntercepted: boolean;
  /** 'node-only' when no system roots exist to extend, so only Node trusts the CA. */
  readonly tlsTrustScope: 'all' | 'node-only';
  /** Hosts that refused the recording certificate, and why. */
  readonly interceptFailures: ReadonlyMap<string, string>;
}

/** Whether the session ended in a way the developer should be warned about. */
export function isFailedOutcome(outcome: ChildOutcome): boolean {
  return outcome.kind === 'failed'
    || (outcome.kind === 'exited' && outcome.code !== 0);
}

/** The port the app is moved to, leaving `listenPort` free for the recorder. */
export function appPortFor(listenPort: number): number {
  return listenPort + 1;
}

export interface ChildEnvironmentOptions {
  readonly base: NodeJS.ProcessEnv;
  readonly appPort: number;
  readonly egressPort: number;
  /** When present, the child is told to trust the recording CA. */
  readonly authority?: CertificateAuthority;
}

/** Absolute path to the compiled Node preload shim that sits beside this file. */
export function nodeShimPath(): string {
  return join(__dirname, 'nodeProxyShim.js');
}

/**
 * Build the environment that makes an app recordable.
 *
 * Lower-cased proxy variables are set alongside the upper-cased ones because
 * clients disagree about which they read — curl and requests prefer lower
 * case, Go prefers upper. Setting one alone silently records nothing.
 *
 * NODE_OPTIONS carries the shim that covers Node itself, whose http module
 * ignores the proxy variables entirely. Any NODE_OPTIONS the developer already
 * set is preserved: overwriting it would quietly disable their debugger or
 * loader the moment they started recording.
 */
export function childEnvironment(
  options: ChildEnvironmentOptions
): NodeJS.ProcessEnv {
  // Database connection strings are rewritten first, so the proxy addresses
  // this produces are the ones the child actually dials.
  const proxyUrl = `http://127.0.0.1:${options.egressPort}`;
  const existingNodeOptions = options.base.NODE_OPTIONS;
  const requireShim = `--require ${nodeShimPath()}`;
  // Trust has to be layered in before the rest, so NODE_EXTRA_CA_CERTS here
  // is not overwritten by the NODE_OPTIONS assignment further down.
  const base = options.authority
    ? trustEnvironment(options.authority, options.base)
    : options.base;
  return {
    ...base,
    PORT: String(options.appPort),
    HTTP_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    COGNIVOX_RECORDING: '1',
    COGNIVOX_EGRESS_PROXY: proxyUrl,
    NODE_OPTIONS: existingNodeOptions
      ? `${existingNodeOptions} ${requireShim}`
      : requireShim,
  };
}

function writeHar(
  exchanges: readonly RecordedExchange[],
  options: RecordSessionOptions
): void {
  mkdirSync(dirname(options.outputPath), { recursive: true });
  writeFileSync(
    options.outputPath,
    JSON.stringify(toHar(exchanges, options.cliVersion), null, 2)
  );
}

/** A recorder for a protocol we cannot decode: relays, records nothing. */
function inertRecorder(protocol: string): ProtocolRecorder {
  return {
    protocol,
    onClientData: () => {},
    onServerData: () => {},
    drain: () => [],
  };
}

function writeDependencies(
  interactions: readonly DependencyInteraction[],
  options: RecordSessionOptions
): string {
  mkdirSync(dirname(options.dependencyPath), { recursive: true });
  writeFileSync(options.dependencyPath, JSON.stringify(
    { version: 1, interactions }, null, 2
  ));
  return options.dependencyPath;
}

function stopAll(servers: readonly Server[], child: ChildProcess | null): void {
  for (const server of servers) {
    // `close` only stops new connections and waits for existing ones to end.
    // Anything holding a keep-alive socket — a browser tab, a connection pool —
    // would keep the recorder alive indefinitely after the developer stopped it.
    server.closeAllConnections();
    server.close();
  }
  if (child && child.exitCode === null) child.kill('SIGTERM');
}

/** How long a stopping app gets to exit before it is killed outright. */
const SHUTDOWN_GRACE_MS = 5000;

/**
 * Stop the child when this process is asked to stop, so the recording is still
 * written.
 *
 * An interactive Ctrl-C reaches the child anyway — it shares this process
 * group — but a `kill` aimed at the CLI alone would otherwise tear down the
 * recorder with the capture still in memory, losing the whole session at the
 * exact moment the developer thought they were saving it.
 */
function forwardStopSignals(child: ChildProcess): () => void {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  let forceTimer: NodeJS.Timeout | null = null;

  const requestStop = () => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    forceTimer = setTimeout(() => child.kill('SIGKILL'), SHUTDOWN_GRACE_MS);
    forceTimer.unref();
  };

  for (const signal of signals) process.on(signal, requestStop);
  return () => {
    for (const signal of signals) process.off(signal, requestStop);
    if (forceTimer) clearTimeout(forceTimer);
  };
}

/**
 * Run a recording session to completion.
 *
 * Resolves when the child exits — by finishing on its own or by the developer
 * pressing Ctrl-C, which reaches the child directly because it shares this
 * process group. Either way the capture is written before returning.
 */
export async function runRecordSession(
  options: RecordSessionOptions
): Promise<RecordSummary> {
  const exchanges: RecordedExchange[] = [];
  const opaque = new Set<string>();
  const appPort = appPortFor(options.listenPort);

  // Certificates are needed by both the HTTPS interceptor and the Postgres
  // TLS upgrade, so the authority is established before either is started.
  const authority = isOpensslAvailable() ? ensureCertificateAuthority() : null;
  const interceptFailures = new Map<string, string>();

  const plan = planRedirects(process.env, options.dependencyBasePort);
  const dependencyInteractions: DependencyInteraction[] = [];
  const dependencyCounts = new Map<string, number>();
  const dependencyServers: { close(): void }[] = [];

  for (const dependency of plan.dependencies) {
    const createRecorder = PROTOCOL_RECORDERS.get(dependency.protocol);
    const onInteraction = (interaction: DependencyInteraction) => {
      dependencyInteractions.push(interaction);
      dependencyCounts.set(
        dependency.variable,
        (dependencyCounts.get(dependency.variable) ?? 0) + 1
      );
    };

    // Postgres upgrades to TLS in-band rather than through a tunnel, so a
    // connection that may negotiate it needs the proxy that can follow the
    // upgrade. Plaintext connections pass through it unchanged.
    if (dependency.protocol === 'postgres' && authority) {
      dependencyServers.push(await startPostgresTlsProxy({
        listenPort: dependency.localPort,
        upstreamHost: dependency.upstreamHost,
        upstreamPort: dependency.upstreamPort,
        authority,
        createRecorder: createRecorder as () => ProtocolRecorder,
        onInteraction,
        onUpgradeFailure: (reason) =>
          interceptFailures.set(`${dependency.variable} (TLS)`, reason),
      }));
      continue;
    }

    // An unknown protocol is still proxied, so the app keeps working; it is
    // simply not decoded, and the summary reports zero for it rather than
    // pretending the dependency was not there.
    dependencyServers.push(await startTcpProxy({
      listenPort: dependency.localPort,
      upstreamHost: dependency.upstreamHost,
      upstreamPort: dependency.upstreamPort,
      createRecorder: createRecorder ?? (() => inertRecorder(dependency.protocol)),
      onInteraction,
    }));
  }

  const ingress = await startIngressProxy({
    listenPort: options.listenPort,
    targetPort: appPort,
    targetHost: '127.0.0.1',
    onExchange: (exchange) => exchanges.push(exchange),
  });
  // Without openssl the recorder still runs and still tunnels HTTPS — it just
  // cannot read it, and says so rather than reporting those calls as absent.
  const interceptor = authority
    ? createHttpsInterceptor({
        authority,
        onExchange: (exchange) => exchanges.push(exchange),
        onInterceptFailure: (host, reason) => interceptFailures.set(host, reason),
      })
    : undefined;

  const egress = await startEgressProxy({
    listenPort: options.egressPort,
    onExchange: (exchange) => exchanges.push(exchange),
    onOpaqueConnect: (host) => opaque.add(host),
    interceptor,
  });

  const [program, ...args] = options.command;
  const child = spawn(program, args, {
    stdio: 'inherit',
    env: childEnvironment({
      base: plan.env,
      appPort,
      egressPort: options.egressPort,
      authority: authority ?? undefined,
    }),
  });

  const releaseSignals = forwardStopSignals(child);
  const outcome = await new Promise<ChildOutcome>((resolve) => {
    child.on('exit', (code, signal) => resolve(
      signal ? { kind: 'signalled', signal } : { kind: 'exited', code: code ?? 0 }
    ));
    child.on('error', (error) => resolve({ kind: 'failed', message: error.message }));
  });
  releaseSignals();

  stopAll([ingress, egress], child);
  if (interceptor) interceptor.close();
  for (const server of dependencyServers) server.close();
  writeHar(exchanges, options);
  const dependencyPath = dependencyInteractions.length > 0
    ? writeDependencies(dependencyInteractions, options)
    : null;

  return {
    ingress: exchanges.filter((e) => e.direction === 'ingress').length,
    egress: exchanges.filter((e) => e.direction === 'egress').length,
    opaqueHosts: [...opaque].sort(),
    outputPath: options.outputPath,
    outcome,
    dependencyCounts,
    dependencies: plan.dependencies,
    dependencyPath,
    tlsIntercepted: authority !== null,
    tlsTrustScope: trustScope(),
    interceptFailures,
  };
}
