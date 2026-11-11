// SPDX-License-Identifier: MIT
/**
 * `useTokenLogo`: the `tokenLogo` prop for a `WidgetProvider`.
 *
 * The native mark for the native coin and its wrapped form (from
 * `brand.nativeLogoUrl`), and each of `launchTokens`' own verified icon once
 * it has been read (none until then, then a re-render). See `lib/tokenLogo.ts`
 * for the rules; this is only the hook around them.
 */

import type { TokenInfo } from "@gullylabs/core-widgets";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Address } from "viem";

import { resolveConfig } from "../config/resolve";
import { chainMarkFor, readLaunchTokenMetadata } from "./tokenLogo";

export function useTokenLogo(launchTokens: readonly Address[]): (token: TokenInfo) => string | null {
  const cfg = resolveConfig();
  const nativeLogoUrl = cfg.nativeLogoUrl;
  const weth = cfg.contracts.weth ?? null;
  const key = useMemo(() => [...new Set(launchTokens.map((a) => a.toLowerCase()))].sort().join(","), [launchTokens]);
  const [icons, setIcons] = useState<Readonly<Record<string, string | null>>>({});
  useEffect(() => {
    if (key === "") return;
    let live = true;
    for (const address of key.split(",")) {
      void readLaunchTokenMetadata(address as Address)
        .then((r) => {
          if (live) setIcons((cur) => (cur[address] === r.image ? cur : { ...cur, [address]: r.image }));
        })
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [key]);
  return useCallback((token: TokenInfo) => chainMarkFor(token, { nativeLogoUrl, weth }) ?? icons[token.address.toLowerCase()] ?? null, [icons, nativeLogoUrl, weth]);
}
