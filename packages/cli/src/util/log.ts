/**
 * Minimal, dependency-free terminal output.
 *
 * Colour is disabled when stdout is not a TTY, when `NO_COLOR` is set, or when
 * `TERM=dumb` - which covers CI logs and the Windows console hosts that do not
 * understand ANSI.
 */

const ESC = "\u001B";

const colorEnabled =
  process.env["NO_COLOR"] === undefined &&
  process.env["TERM"] !== "dumb" &&
  process.stdout.isTTY === true;

function wrap(open: string, close: string) {
  return (text: string): string => (colorEnabled ? `${ESC}[${open}m${text}${ESC}[${close}m` : text);
}

export const style = {
  bold: wrap("1", "22"),
  dim: wrap("2", "22"),
  red: wrap("31", "39"),
  green: wrap("32", "39"),
  yellow: wrap("33", "39"),
  blue: wrap("34", "39"),
  cyan: wrap("36", "39"),
} as const;

export function info(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function step(message: string): void {
  process.stdout.write(`${style.cyan("*")} ${message}\n`);
}

export function ok(message: string): void {
  process.stdout.write(`${style.green("+")} ${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`${style.yellow("!")} ${message}\n`);
}

export function error(message: string): void {
  process.stderr.write(`${style.red("x")} ${message}\n`);
}

/** Renders `label: value` rows with the values aligned into one column. */
export function table(rows: ReadonlyArray<readonly [string, string]>): string {
  const width = rows.reduce((max, [label]) => Math.max(max, label.length), 0);
  return rows.map(([label, value]) => `  ${label.padEnd(width)}  ${style.bold(value)}`).join("\n");
}

/**
 * The exit codes, a stable part of the CLI's interface: scripts branch on them.
 *
 *   0    done
 *   1    failed (bad input, a read that found nothing)
 *   2    usage: unknown flag, missing value
 *   3    Gully Core has no deployment on that chain, or not that feature
 *   4    the transaction would revert, or did
 *   5    an RPC or the Router API could not be reached
 *   6    a safety guard refused: slippage, price impact, a mainnet write without confirmation
 *   130  cancelled at a prompt
 */
export const EXIT = { OK: 0, ERROR: 1, USAGE: 2, NO_DEPLOYMENT: 3, SIMULATION: 4, NETWORK: 5, REFUSED: 6, CANCELLED: 130 } as const;

/**
 * An error whose message is already meant for a user: printed without a stack
 * trace. Anything else that escapes to the top level is a bug and keeps its
 * stack so it can be reported.
 */
export class UserError extends Error {
  readonly hint: string | undefined;
  readonly exitCode: number;

  constructor(message: string, hint?: string, exitCode: number = EXIT.ERROR) {
    super(message);
    this.name = "UserError";
    this.hint = hint;
    this.exitCode = exitCode;
  }
}

/** The command line itself is wrong: an unknown flag, a missing value. Exit code 2. */
export class UsageError extends UserError {
  constructor(message: string, hint?: string) {
    super(message, hint, EXIT.USAGE);
    this.name = "UsageError";
  }
}

/** Prints an error the way the top-level handler should and returns an exit code. */
export function reportFatal(err: unknown): number {
  if (err instanceof UserError) {
    error(err.message);
    /* To stderr, like the error: with --json, stdout carries one document and nothing else. */
    if (err.hint !== undefined) process.stderr.write(`${style.dim(`  ${err.hint}`)}
`);
    return err.exitCode;
  }
  error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  return 1;
}
