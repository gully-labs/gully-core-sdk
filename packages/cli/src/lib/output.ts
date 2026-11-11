// SPDX-License-Identifier: MIT
/**
 * Where output goes, and the one stable `--json` shape.
 *
 * With `--json`, stdout carries EXACTLY ONE JSON document and nothing else, so `gullycore … --json | jq`
 * always parses. Every human line (progress, review screens, warnings) goes to stderr in that mode.
 * Without `--json`, human output goes to stdout and warnings to stderr as usual.
 *
 * The envelope is versioned (`schema: "gullycore.cli/1"`). Within a schema version fields are only ever
 * ADDED; a rename or a type change is a new version. Every bigint is a decimal string.
 */

import { stripAnsi, ui } from "./brand.js";
import { sentHashes } from "./sentLog.js";

export const JSON_SCHEMA = "gullycore.cli/1";

export type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json };

/** Recursively turns bigints into decimal strings and drops `undefined`, so any result can be emitted. */
export function toJson(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((v) => toJson(v));
  if (typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = toJson(v);
    }
    return out;
  }
  return String(value);
}

export interface SuccessEnvelope {
  readonly schema: typeof JSON_SCHEMA;
  readonly command: string;
  readonly ok: true;
  readonly [k: string]: Json;
}

export interface FailureEnvelope {
  readonly schema: typeof JSON_SCHEMA;
  readonly command: string;
  readonly ok: false;
  readonly error: { readonly message: string; readonly hint: string | null; readonly exitCode: number };
  /** Hashes that left this process before the failure: they are on the chain whatever happened next. */
  readonly hashes?: readonly string[];
}

export function successEnvelope(command: string, body: Record<string, unknown>): SuccessEnvelope {
  const json = toJson(body) as Record<string, Json>;
  /* Every hash this process broadcast, whatever the command put (or forgot to put) in its own body. */
  const hashes = sentHashes();
  const withHash = hashes.length === 0 ? {} : { hash: hashes[hashes.length - 1] as string, hashes: [...hashes] as string[] };
  return { schema: JSON_SCHEMA, command, ok: true, ...withHash, ...json } as SuccessEnvelope;
}

export function failureEnvelope(command: string, message: string, hint: string | null, exitCode = 1): FailureEnvelope {
  const hashes = sentHashes();
  return { schema: JSON_SCHEMA, command, ok: false, error: { message, hint, exitCode }, ...(hashes.length === 0 ? {} : { hashes: [...hashes] }) };
}

export class Output {
  readonly json: boolean;
  private emitted = false;

  constructor(json: boolean) {
    this.json = json;
  }

  /** A human line. In `--json` mode it goes to stderr, uncoloured, so stdout stays one document. */
  line(text = ""): void {
    if (this.json) process.stderr.write(`${stripAnsi(text)}\n`);
    else process.stdout.write(`${text}\n`);
  }

  warn(text: string): void {
    process.stderr.write(`${ui.bold("!")} ${this.json ? stripAnsi(text) : text}\n`);
  }

  /** `label  value` rows, aligned. */
  rows(rows: ReadonlyArray<readonly [string, string]>): void {
    const width = rows.reduce((m, [l]) => Math.max(m, l.length), 0);
    for (const [label, value] of rows) this.line(`  ${ui.muted(label.padEnd(width))}  ${value}`);
  }

  /** The command's single JSON document. Only in `--json` mode; a second call is a bug. */
  result(command: string, body: Record<string, unknown>): void {
    if (!this.json) return;
    if (this.emitted) throw new Error("a command emitted two JSON documents");
    this.emitted = true;
    process.stdout.write(`${JSON.stringify(successEnvelope(command, body), null, 2)}\n`);
  }

  failure(command: string, message: string, hint: string | null, exitCode = 1): void {
    if (!this.json || this.emitted) return;
    this.emitted = true;
    process.stdout.write(`${JSON.stringify(failureEnvelope(command, message, hint, exitCode), null, 2)}\n`);
  }
}
