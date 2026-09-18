/**
 * Redirects an app's database connections through the recorder.
 *
 * This is the piece that replaces Keploy's eBPF. They redirect egress TCP from
 * the kernel, which is transparent but costs Linux, root and cgroups. Database
 * connections have a second address that is already ours to change: the
 * connection string in the environment. Rewriting the host and port sends the
 * traffic through a proxy with no privileges at all.
 *
 * Only the authority is replaced. Credentials, database name and query
 * parameters are preserved exactly, because they are what the app authenticates
 * and selects with — a rewrite that dropped `?sslmode=disable` would change the
 * behaviour it is supposed to be observing.
 */

/** Connection-string variables, mapped to the protocol they carry. */
const VARIABLE_PROTOCOLS: ReadonlyMap<string, string> = new Map([
  ['DATABASE_URL', 'postgres'],
  ['POSTGRES_URL', 'postgres'],
  ['POSTGRESQL_URL', 'postgres'],
  ['PG_URL', 'postgres'],
  ['REDIS_URL', 'redis'],
  ['REDIS_URI', 'redis'],
  ['CACHE_URL', 'redis'],
  ['MONGO_URL', 'mongodb'],
  ['MONGODB_URI', 'mongodb'],
  ['MONGODB_URL', 'mongodb'],
]);

/** URL schemes that confirm a protocol, for variables named something else. */
const SCHEME_PROTOCOLS: ReadonlyMap<string, string> = new Map([
  ['postgres:', 'postgres'], ['postgresql:', 'postgres'],
  ['redis:', 'redis'], ['rediss:', 'redis'],
  ['mongodb:', 'mongodb'],
]);

const DEFAULT_PORTS: ReadonlyMap<string, number> = new Map([
  ['postgres', 5432], ['redis', 6379], ['mongodb', 27017],
]);

/** One dependency the recorder will sit in front of. */
export interface RedirectedDependency {
  readonly variable: string;
  readonly protocol: string;
  readonly upstreamHost: string;
  readonly upstreamPort: number;
  readonly localPort: number;
  /** True when the URL asked for TLS, which we cannot read. */
  readonly encrypted: boolean;
}

export interface RedirectPlan {
  readonly env: NodeJS.ProcessEnv;
  readonly dependencies: readonly RedirectedDependency[];
  /** Variables that looked like connection strings but could not be parsed. */
  readonly unparsed: readonly string[];
}

function protocolOf(variable: string, url: URL): string | null {
  return SCHEME_PROTOCOLS.get(url.protocol)
    ?? VARIABLE_PROTOCOLS.get(variable)
    ?? null;
}

/**
 * Build the rewritten environment and the list of proxies to start.
 *
 * Ports are handed out sequentially from `basePort` so each dependency gets its
 * own listener; sharing one would make it impossible to know which upstream a
 * connection was meant for.
 */
export function planRedirects(
  base: NodeJS.ProcessEnv,
  basePort: number
): RedirectPlan {
  const env: NodeJS.ProcessEnv = { ...base };
  const dependencies: RedirectedDependency[] = [];
  const unparsed: string[] = [];
  let nextPort = basePort;

  for (const [variable, value] of Object.entries(base)) {
    if (!value || !VARIABLE_PROTOCOLS.has(variable)) continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      unparsed.push(variable);
      continue;
    }
    const protocol = protocolOf(variable, url);
    if (!protocol) {
      unparsed.push(variable);
      continue;
    }

    const upstreamPort = Number(url.port) || DEFAULT_PORTS.get(protocol) || 0;
    const localPort = nextPort;
    nextPort += 1;

    dependencies.push({
      variable,
      protocol,
      upstreamHost: url.hostname,
      upstreamPort,
      localPort,
      encrypted: url.protocol === 'rediss:' || url.searchParams.get('sslmode') === 'require',
    });

    url.hostname = '127.0.0.1';
    url.port = String(localPort);
    env[variable] = url.toString();
  }

  return { env, dependencies, unparsed };
}
