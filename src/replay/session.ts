/**
 * Orchestration for `cvx replay`: start a server per recorded dependency,
 * point the app at them, and run it.
 *
 * Which servers to start is decided by the recording itself rather than by the
 * current environment — the machine running the tests may have no DATABASE_URL
 * at all, which is rather the point.
 */

import { spawn } from 'child_process';
import type { Server } from 'net';
import { RedisReplay, startRedisReplayServer } from './redisReplayServer';
import { PostgresReplay, startPostgresReplayServer } from './postgresReplayServer';
import { MongoReplay, startMongoReplayServer } from './mongoReplayServer';
import { DivergenceTracker, type DivergenceWarning } from './divergence';
import type { DependencyInteraction } from '../record/tcp/protocol';

/** The environment variable each protocol's replay server is published as. */
const PROTOCOL_VARIABLES: ReadonlyMap<string, string> = new Map([
  ['postgres', 'DATABASE_URL'],
  ['redis', 'REDIS_URL'],
  ['mongodb', 'MONGODB_URI'],
]);

const URL_SCHEMES: ReadonlyMap<string, string> = new Map([
  ['postgres', 'postgres://cognivox:replay@127.0.0.1'],
  ['redis', 'redis://127.0.0.1'],
  // `directConnection` stops the driver trying to discover a replica set that
  // does not exist, which otherwise stalls every command until it times out.
  ['mongodb', 'mongodb://127.0.0.1'],
]);

export interface ReplaySessionOptions {
  readonly command: readonly string[];
  readonly interactions: readonly Record<string, unknown>[];
  readonly basePort: number;
}

export interface ReplayServerInfo {
  readonly protocol: string;
  readonly variable: string;
  readonly port: number;
}

export interface ReplaySummary {
  readonly matched: number;
  readonly unmatched: readonly string[];
  readonly servers: readonly ReplayServerInfo[];
  readonly exitCode: number | null;
  /** Places the replay knowingly stopped reflecting a real database. */
  readonly divergences: readonly DivergenceWarning[];
}

interface StartedServer {
  readonly info: ReplayServerInfo;
  readonly server: Server;
  stats(): { matched: number; unmatched: readonly string[] };
}

/** Which protocols the recording actually contains. */
function protocolsIn(interactions: readonly Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  for (const interaction of interactions) seen.add(String(interaction.protocol));
  return [...seen].filter((protocol) => PROTOCOL_VARIABLES.has(protocol)).sort();
}

async function startFor(
  protocol: string,
  interactions: readonly DependencyInteraction[],
  port: number,
  tracker: DivergenceTracker
): Promise<StartedServer> {
  const variable = PROTOCOL_VARIABLES.get(protocol) as string;
  const info = { protocol, variable, port };

  if (protocol === 'redis') {
    const replay = new RedisReplay(interactions);
    return { info, server: await startRedisReplayServer(replay, port), stats: () => replay.stats() };
  }
  if (protocol === 'mongodb') {
    const replay = new MongoReplay(interactions);
    return { info, server: await startMongoReplayServer(replay, port), stats: () => replay.stats() };
  }
  const replay = new PostgresReplay(interactions, tracker);
  return { info, server: await startPostgresReplayServer(replay, port), stats: () => replay.stats() };
}

/** Run the command with every recorded dependency served locally. */
export async function runReplaySession(
  options: ReplaySessionOptions
): Promise<ReplaySummary> {
  const interactions = options.interactions as unknown as DependencyInteraction[];
  const started: StartedServer[] = [];
  const tracker = new DivergenceTracker();
  let port = options.basePort;

  for (const protocol of protocolsIn(options.interactions)) {
    started.push(await startFor(protocol, interactions, port, tracker));
    port += 1;
  }

  const env: NodeJS.ProcessEnv = { ...process.env, COGNIVOX_REPLAY: '1' };
  for (const { info } of started) {
    const scheme = URL_SCHEMES.get(info.protocol) as string;
    const suffix = info.protocol === 'mongodb' ? '/?directConnection=true' : '';
    env[info.variable] = `${scheme}:${info.port}${suffix}`;
  }

  const [program, ...args] = options.command;
  const child = spawn(program, args, { stdio: 'inherit', env });
  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', () => resolve(null));
  });

  for (const { server } of started) server.close();

  return {
    matched: started.reduce((total, s) => total + s.stats().matched, 0),
    unmatched: started.flatMap((s) => s.stats().unmatched),
    servers: started.map((s) => s.info),
    exitCode,
    divergences: tracker.all(),
  };
}
