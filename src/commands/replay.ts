/**
 * `cvx replay` — run an app or its tests against a recording instead of its
 * real dependencies.
 *
 *   cvx replay -- npm test
 *
 * This is the half that makes recording worth doing. The same connection-string
 * variables `cvx record` rewrote to point at the recorder are rewritten again,
 * this time to point at servers that answer from the recording — so the app
 * runs with no database, no cache, and no network.
 *
 * Like `cvx record`, it needs no account: the recording is a local file.
 */

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runReplaySession, type ReplaySummary } from '../replay/session';
import { palette, icon, heading, panel, cliError } from '../ui';

const DEFAULT_RECORDING = 'cognivox/dependencies.json';
const DEFAULT_BASE_PORT = 16890;

interface ReplayOptions {
  recording: string;
  basePort: string;
}

function loadInteractions(path: string): Record<string, unknown>[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const interactions = parsed?.interactions;
  if (!Array.isArray(interactions)) {
    throw new Error(`${path} does not look like a cvx recording (no "interactions" array)`);
  }
  return interactions;
}

/**
 * The summary's job is to make an incomplete recording obvious.
 *
 * A replay where half the queries were never recorded still runs, and its
 * errors surface as application failures that look like real bugs. Naming the
 * unmatched statements is what turns that into a diagnosable result.
 */
function summaryBody(summary: ReplaySummary): string {
  const lines = [
    `${icon.pass} ${summary.matched} dependency call(s) answered from the recording`,
  ];

  for (const dependency of summary.servers) {
    lines.push(`  ${dependency.variable} ${palette.dim(`(${dependency.protocol}, port ${dependency.port})`)}`);
  }

  if (summary.unmatched.length > 0) {
    lines.push(
      '',
      `${icon.warn} ${summary.unmatched.length} call(s) had no recording and were answered with an error:`,
      ...summary.unmatched.slice(0, 10).map((entry) => `   ${palette.dim(entry)}`)
    );
    if (summary.unmatched.length > 10) {
      lines.push(palette.dim(`   ...and ${summary.unmatched.length - 10} more`));
    }
    lines.push(palette.dim('   Record the path that makes these calls, then replay again.'));
  }

  // These are not failures. They are the places where a recording cannot stand
  // in for a database, and naming them is the difference between a test the
  // developer can trust and one that quietly passed on stale rows.
  if (summary.divergences.length > 0) {
    lines.push('', heading('Where replay differs from a real database'));
    for (const warning of summary.divergences.slice(0, 8)) {
      lines.push(`  ${palette.dim(warning.statement)}`);
      lines.push(`    ${warning.detail}`);
    }
    if (summary.divergences.length > 8) {
      lines.push(palette.dim(`  ...and ${summary.divergences.length - 8} more`));
    }
  }

  return lines.join('\n');
}

export function registerReplayCommand(program: Command): void {
  program
    .command('replay')
    .description('Run a command against recorded dependencies (no database needed)')
    .option('--recording <file>', `Recording to replay (default: ${DEFAULT_RECORDING})`, DEFAULT_RECORDING)
    .option('--base-port <port>', `First port for replay servers (default: ${DEFAULT_BASE_PORT})`, String(DEFAULT_BASE_PORT))
    .argument('<command...>', 'Command to run, after --')
    .addHelpText('after', `
Examples:
  $ cvx replay -- npm test
  $ cvx replay --recording ci/deps.json -- pytest
`)
    .action(async (command: string[], options: ReplayOptions) => {
      try {
        const recordingPath = resolve(process.cwd(), options.recording);
        const summary = await runReplaySession({
          command,
          interactions: loadInteractions(recordingPath),
          basePort: Number(options.basePort),
        });

        const failed = summary.exitCode !== 0;
        console.log(panel(summaryBody(summary), {
          title: failed ? `Command exited with code ${summary.exitCode}` : 'Replayed',
          tone: failed ? 'warn' : 'success',
        }));
        process.exitCode = summary.exitCode ?? 1;
      } catch (error) {
        cliError(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}
