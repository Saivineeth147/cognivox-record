/**
 * `cvx record` — turn a running app into a test suite by using it.
 *
 *   cvx record -- npm start
 *   cvx record --port 8080 -- ./gradlew bootRun
 *
 * This is the capability Keploy is known for, without the thing that keeps
 * most developers from running it: no eBPF, no Linux 4.15+, no root, no kernel
 * modules. Two proxies and two environment-variable conventions get the same
 * request/response pairs on macOS and Windows as well as Linux.
 *
 * It deliberately requires no API key. Recording is entirely local — nothing
 * leaves the machine — and a tool that demands an account before it will show
 * you anything is one most people never evaluate at all.
 */

import { Command } from 'commander';
import { resolve } from 'path';
import {
  runRecordSession, appPortFor, isFailedOutcome,
  type RecordSummary, type ChildOutcome,
} from '../record/session';
import { palette, icon, heading, panel, cliError } from '../ui';

const DEFAULT_APP_PORT = 3000;
const DEFAULT_EGRESS_PORT = 16789;
const DEFAULT_OUTPUT = 'cognivox/recording.har';
const DEFAULT_DEPENDENCIES = 'cognivox/dependencies.json';
const DEFAULT_DEPENDENCY_BASE_PORT = 16790;

interface RecordOptions {
  port: string;
  egressPort: string;
  out: string;
}

function startupNotice(listenPort: number, egressPort: number): string {
  return [
    `${palette.dim('recording on')}  http://localhost:${listenPort}`,
    `${palette.dim('your app on')}   http://localhost:${appPortFor(listenPort)}  ${palette.dim('(PORT was set for you)')}`,
    `${palette.dim('outbound via')}  http://127.0.0.1:${egressPort}`,
    '',
    'Use your app normally — every call through this port becomes a test case.',
    `Stop with ${palette.dim('Ctrl-C')} when you are done.`,
  ].join('\n');
}

/**
 * The summary has to distinguish "captured nothing because you sent nothing"
 * from "captured nothing because the traffic went somewhere I cannot see".
 * Reporting a clean zero for the second case is how a recorder loses trust.
 */
function summaryBody(summary: RecordSummary): string {
  const lines = [
    `${icon.pass} ${summary.ingress} request(s) to your app  ${palette.dim('-> test cases')}`,
    `${icon.pass} ${summary.egress} outbound call(s)         ${palette.dim('-> mocks')}`,
    '',
    `${palette.dim('written to')}  ${summary.outputPath}`,
  ];

  if (summary.dependencies.length > 0) {
    lines.push('', heading('Dependencies'));
    for (const dependency of summary.dependencies) {
      const count = summary.dependencyCounts.get(dependency.variable) ?? 0;
      lines.push(`  ${dependency.variable} ${palette.dim(`(${dependency.protocol})`)}  ${dependencyNote(dependency, count, summary)}`);
    }
    if (summary.dependencyPath) {
      lines.push(`${palette.dim('  written to')}  ${summary.dependencyPath}`);
    }
  }

  // Three different TLS outcomes, and collapsing them would hide the one that
  // matters: a host that actively refused our certificate is not the same as
  // one we never had the tools to read.
  if (summary.opaqueHosts.length > 0) {
    lines.push(
      '',
      `${icon.warn} ${summary.opaqueHosts.length} HTTPS host(s) were tunnelled but not recorded:`,
      ...summary.opaqueHosts.map((host) => `   ${palette.dim(host)}`),
      palette.dim(summary.tlsIntercepted
        ? '   These connected before interception was ready.'
        : '   openssl was not found, so TLS could not be read. Install it to capture HTTPS.')
    );
  }

  if (summary.interceptFailures.size > 0) {
    lines.push(
      '',
      `${icon.warn} ${summary.interceptFailures.size} host(s) refused the recording certificate:`,
      ...[...summary.interceptFailures].map(([host, reason]) =>
        `   ${palette.dim(`${host} — ${reason}`)}`),
      palette.dim('   These clients pin certificates or carry their own trust store.')
    );
  }

  if (summary.ingress === 0 && summary.egress === 0) {
    lines.push(
      '',
      palette.dim('Nothing was captured. Traffic has to go through the recording'),
      palette.dim("port for it to be seen - send it to the port above, not to your app's.")
    );
  } else {
    lines.push('', heading('Next'), `  cvx import har ${summary.outputPath} --run`);
    if (summary.dependencyPath) {
      lines.push(`  cvx replay -- <your test command>   ${palette.dim('(no database needed)')}`);
    }
  }

  return lines.join('\n');
}

/** Title that names what actually happened, rather than always claiming success. */
function outcomeTitle(outcome: ChildOutcome): string {
  switch (outcome.kind) {
    case 'failed':
      return `Could not start your app: ${outcome.message}`;
    case 'exited':
      return outcome.code === 0 ? 'Recorded' : `App exited with code ${outcome.code}`;
    case 'signalled':
      return 'Recorded';
  }
}

/**
 * What to say beside a dependency.
 *
 * A TLS connection string used to be reported as unreadable on sight. Now that
 * the upgrade can be followed, the count is the truth and the TLS flag is only
 * worth mentioning when it explains a zero — otherwise the summary would call a
 * successful recording a failure, which is the exact confusion it exists to
 * prevent.
 */
export function dependencyNote(
  dependency: { encrypted: boolean },
  count: number,
  summary: { tlsIntercepted: boolean }
): string {
  if (count > 0) {
    return dependency.encrypted
      ? `${count} interaction(s) ${palette.dim('(TLS, decoded)')}`
      : `${count} interaction(s)`;
  }
  if (dependency.encrypted && !summary.tlsIntercepted) {
    return palette.dim('TLS — relayed but not readable (openssl not found)');
  }
  return '0 interaction(s)';
}

function parsePort(value: string, label: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be a port number between 1 and 65535, got "${value}"`);
  }
  return port;
}

export function registerRecordCommand(program: Command): void {
  program
    .command('record')
    .description('Record a running app into a test suite (no account needed)')
    .option('--port <port>', `Port your app normally listens on (default: ${DEFAULT_APP_PORT})`, String(DEFAULT_APP_PORT))
    .option('--egress-port <port>', `Port for the outbound recorder (default: ${DEFAULT_EGRESS_PORT})`, String(DEFAULT_EGRESS_PORT))
    .option('--out <file>', `Where to write the recording (default: ${DEFAULT_OUTPUT})`, DEFAULT_OUTPUT)
    .argument('<command...>', 'Command that starts your app, after --')
    .addHelpText('after', `
Examples:
  $ cvx record -- npm start
  $ cvx record --port 8080 -- python -m uvicorn main:app
  $ cvx record --out api.har -- go run ./cmd/server
`)
    .action(async (command: string[], options: RecordOptions) => {
      try {
        const listenPort = parsePort(options.port, '--port');
        const egressPort = parsePort(options.egressPort, '--egress-port');
        console.log(panel(startupNotice(listenPort, egressPort), { title: 'cvx record', tone: 'info' }));

        const summary = await runRecordSession({
          command,
          listenPort,
          egressPort,
          outputPath: resolve(process.cwd(), options.out),
          dependencyPath: resolve(process.cwd(), DEFAULT_DEPENDENCIES),
          dependencyBasePort: DEFAULT_DEPENDENCY_BASE_PORT,
          cliVersion: program.version() || '0.0.0',
        });

        // A crashed app that recorded nothing must not be reported in a
        // success panel — that reads as "your API has no traffic" when what
        // actually happened is "your app never started".
        const failed = isFailedOutcome(summary.outcome);
        console.log(panel(summaryBody(summary), {
          title: outcomeTitle(summary.outcome),
          tone: failed ? 'warn' : 'success',
        }));
        process.exitCode = failed ? 1 : 0;
      } catch (error) {
        cliError(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}
