#!/usr/bin/env node
/**
 * The standalone `cvx-record` binary.
 *
 * The same two commands ship inside the Cognivox CLI as `cvx record` and
 * `cvx replay`; this entry point exists so they can be used with nothing else
 * installed and no account.
 */

import { Command } from 'commander';
import { registerRecordCommand } from './commands/record';
import { registerReplayCommand } from './commands/replay';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require('../package.json') as { version: string };

const program = new Command()
  .name('cvx-record')
  .description('Record a running app into a test suite; replay it with no database')
  .version(version);

registerRecordCommand(program);
registerReplayCommand(program);
program.parse();
