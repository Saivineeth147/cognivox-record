/**
 * The handful of terminal formatters the record and replay commands use.
 *
 * Deliberately minimal. The full Cognivox CLI has a richer UI module —
 * spinners, tables, banners, prompts — and this package must not depend on it,
 * because the whole point of the package is to run with nothing else
 * installed. Five helpers on chalk and boxen are the entire footprint.
 */

import chalk from 'chalk';
import boxen from 'boxen';

/** True when styling is appropriate: a TTY, and NO_COLOR unset. */
function isColorEnabled(): boolean {
  return !process.env.NO_COLOR && Boolean(process.stdout.isTTY);
}

/** Themed colour helpers, matching the Cognivox CLI's palette. */
export const palette = {
  brand: chalk.hex('#3b82f6'),
  success: chalk.green,
  warn: chalk.yellow,
  danger: chalk.red,
  info: chalk.cyan,
  dim: chalk.dim,
  muted: chalk.gray,
  bold: chalk.bold,
};

/** Status glyphs. The glyph survives with colour disabled, so logs keep meaning. */
export const icon = {
  pass: palette.success('✓'),
  fail: palette.danger('✗'),
  warn: palette.warn('⚠'),
  info: palette.info('ℹ'),
};

const DIVIDER_WIDTH = 60;

/** A bold section heading with an underline rule. */
export function heading(text: string): string {
  const rule = palette.muted('─'.repeat(Math.min(text.length + 4, DIVIDER_WIDTH)));
  return `${palette.brand(palette.bold(text))}\n${rule}`;
}

export type PanelTone = 'brand' | 'success' | 'warn' | 'danger' | 'info' | 'muted';

const TONE_TO_BORDER: Record<PanelTone, string> = {
  brand: 'blue', success: 'green', warn: 'yellow', danger: 'red', info: 'cyan', muted: 'gray',
};

/** Content in a rounded panel; plain title + content when styling is off. */
export function panel(content: string, options: { title?: string; tone?: PanelTone } = {}): string {
  if (!isColorEnabled()) return options.title ? `${options.title}\n${content}` : content;
  return boxen(content, {
    title: options.title,
    titleAlignment: 'left',
    padding: { top: 0, bottom: 0, left: 1, right: 1 },
    borderStyle: 'round',
    borderColor: TONE_TO_BORDER[options.tone ?? 'brand'],
  });
}

/** Print an error and exit non-zero. */
export function cliError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${icon.fail} ${palette.danger('Error:')} ${message}\n`);
  process.exit(1);
}
