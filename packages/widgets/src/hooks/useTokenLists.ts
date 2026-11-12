// SPDX-License-Identifier: MIT
/**
 * Fetches, validates and merges the token lists a widget was given, for the
 * adapter's chain. Headless: returns entries and per-URL failures, renders
 * nothing. A list that fails to load is reported by URL and reason and simply
 * contributes no tokens — the picker still works on the adapter's tokens and
 * the lists that did load. Nothing is cached across mounts; caching is the
 * host app's job (the SDK is localStorage-free by design).
 */

import { fetchTokenList, mergeTokenLists, type TokenList } from "@gullylabs/core-sdk";
import { useEffect, useMemo, useState } from "react";
import type { TokenInfo } from "../adapters/protocol.js";
import { useWidgetContext } from "../context/WidgetProvider.js";
import { isTokenListUrl, tokensFromMergedList, type TokenListInput } from "../core/tokenLists.js";

export interface TokenListFailure {
  readonly url: string;
  readonly message: string;
}

export interface TokenListsResource {
  /** Entries from every list that loaded, merged (first list wins), for the adapter's chain. */
  readonly tokens: readonly TokenInfo[];
  /** `loading` while any URL is in flight; `ready` once every input settled (some may have failed). */
  readonly status: "idle" | "loading" | "ready";
  readonly failures: readonly TokenListFailure[];
  /** The names of the lists that loaded, in input order. */
  readonly sources: readonly string[];
}

const EMPTY: TokenListsResource = { tokens: [], status: "idle", failures: [], sources: [] };

/** A stable identity for the inputs so a re-render with the same lists does not refetch. */
function keyOf(inputs: readonly TokenListInput[] | undefined): string {
  if (inputs === undefined) return "";
  return inputs.map((i) => (isTokenListUrl(i) ? `url:${i.url}` : `list:${i.name}@${i.version.major}.${i.version.minor}.${i.version.patch}:${i.tokens.length}`)).join("|");
}

/** Loads `inputs` (lists or URLs) and merges them for the adapter's chain. */
export function useTokenLists(inputs: readonly TokenListInput[] | undefined): TokenListsResource {
  const { chain } = useWidgetContext();
  const key = keyOf(inputs);
  const [state, setState] = useState<{ key: string; resource: TokenListsResource }>({ key: "", resource: EMPTY });

  useEffect(() => {
    if (inputs === undefined || inputs.length === 0) {
      setState({ key, resource: EMPTY });
      return;
    }
    let cancelled = false;
    setState((s) => (s.key === key ? s : { key, resource: { ...EMPTY, status: "loading" } }));
    void Promise.all(
      inputs.map(async (input): Promise<TokenList | TokenListFailure> => {
        if (!isTokenListUrl(input)) return input;
        try {
          return (await fetchTokenList(input.url)).list;
        } catch (e) {
          return { url: input.url, message: e instanceof Error ? e.message : String(e) };
        }
      }),
    ).then((settled) => {
      if (cancelled) return;
      const lists = settled.filter((s): s is TokenList => !("url" in s && "message" in s));
      const failures = settled.filter((s): s is TokenListFailure => "url" in s && "message" in s);
      const merged = mergeTokenLists(lists, { chainId: chain.chainId });
      setState({ key, resource: { tokens: tokensFromMergedList(merged), status: "ready", failures, sources: lists.map((l) => l.name) } });
    });
    return () => {
      cancelled = true;
    };
    // `key` stands in for `inputs`: a new array with the same lists must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, chain.chainId]);

  return useMemo(() => (state.key === key ? state.resource : inputs === undefined || inputs.length === 0 ? EMPTY : { ...EMPTY, status: "loading" }), [state, key, inputs]);
}
