// SPDX-License-Identifier: MIT
/**
 * Swap settings in a Radix Popover: slippage tolerance (auto, presets, custom)
 * and the high-impact acknowledgement. Nothing here is hidden from the
 * summary: the chosen tolerance is always printed in the details.
 */

import type { ReactElement } from "react";
import * as Popover from "@radix-ui/react-popover";
import { useState } from "react";
import { formatPercentFromBps } from "../../core/format.js";
import { MAX_SLIPPAGE_BPS } from "../../core/math.js";
import { usePortalContainer } from "../portal.js";

const PRESETS = [10, 50, 100] as const;

export interface SwapSettingsProps {
  readonly slippageBps: number;
  readonly defaultSlippageBps: number;
  readonly onSlippageChange: (bps: number) => void;
}

export function SwapSettings(props: SwapSettingsProps): ReactElement {
  const container = usePortalContainer();
  const [custom, setCustom] = useState("");
  const isAuto = props.slippageBps === props.defaultSlippageBps && custom === "";

  const applyCustom = (text: string): void => {
    setCustom(text);
    const pct = Number.parseFloat(text);
    if (!Number.isFinite(pct) || pct < 0) return;
    const bps = Math.round(pct * 100);
    if (bps > MAX_SLIPPAGE_BPS) return;
    props.onSlippageChange(bps);
  };
  const high = props.slippageBps > 100;
  const low = props.slippageBps < 5;

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="gullycore-icon-button gullycore-settings-trigger" aria-label="Swap settings">
          <span aria-hidden="true">⚙</span>
          <span className="gullycore-settings-trigger__value">{formatPercentFromBps(props.slippageBps)}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal container={container}>
        <Popover.Content className="gullycore-popover" align="end" sideOffset={8}>
          <div className="gullycore-popover__row">
            <span className="gullycore-label">Max slippage</span>
            <span className="gullycore-popover__value">{isAuto ? "Auto" : "Custom"}</span>
          </div>
          <div className="gullycore-field-row">
            <button
              type="button"
              className="gullycore-chip"
              aria-pressed={isAuto}
              onClick={() => {
                setCustom("");
                props.onSlippageChange(props.defaultSlippageBps);
              }}
            >
              Auto
            </button>
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                className="gullycore-chip"
                aria-pressed={!isAuto && custom === "" && props.slippageBps === p}
                onClick={() => {
                  setCustom("");
                  props.onSlippageChange(p);
                }}
              >
                {formatPercentFromBps(p)}
              </button>
            ))}
            <label className="gullycore-custom-slippage">
              <input type="text" inputMode="decimal" placeholder="0.50" aria-label="Custom slippage, percent" value={custom} onChange={(e) => applyCustom(e.target.value)} />
              <span>%</span>
            </label>
          </div>
          {high ? <p className="gullycore-note gullycore-note--warn">Above 1%: a transaction may be front-run for the difference.</p> : null}
          {low ? <p className="gullycore-note gullycore-note--warn">Below 0.05%: the transaction is likely to revert on a moving price.</p> : null}
          <p className="gullycore-note">
            The transaction reverts if the received amount falls below the minimum shown in the details. Auto is {formatPercentFromBps(props.defaultSlippageBps)}.
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
