// SPDX-License-Identifier: MIT
/**
 * Presentational primitives shared by the three styled widgets.
 *
 * Nothing here holds protocol state. Each piece is a thin, accessible shell
 * over native form elements: a real `<label>` for every input, a real `<button>`
 * for every action, and one polite live region per widget so a screen reader
 * hears quote and transaction changes without the focus moving.
 */

import type { ReactElement } from "react";
import {
  useEffect,
  useId,
  useMemo,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { PortalContainerProvider } from "./portal.js";
import type { TokenInfo } from "../adapters/protocol.js";
import { useWidgetContext } from "../context/WidgetProvider.js";
import { formatAmount } from "../core/format.js";
import { injectWidgetStyles } from "../styles/css.js";
import { describeError } from "../core/errors.js";

/** Props for {@link WidgetShell}. */
export interface WidgetShellProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly children: ReactNode;
  /** Rendered at the top-right of the header, e.g. a settings control. */
  readonly headerAction?: ReactNode;
  /**
   * Rendered in the header in place of the visible title (the swap widget's
   * Buy / Sell pill). The title stays the section's name and its heading, for
   * assistive technology only.
   */
  readonly headerContent?: ReactNode;
  readonly className?: string;
  /**
   * `true`: no visible header row at all; the title stays the section's
   * heading for assistive technology only. For a host that draws its own
   * heading (the swap widget's `panel` variant).
   */
  readonly hideHeader?: boolean;
  /**
   * `true`: the widget draws no frame of its own (no padding, border,
   * background or shadow, no max width), for a host that already puts it in
   * a panel. Sets `data-gullycore-bare` on the root.
   */
  readonly bare?: boolean;
}

/**
 * The outer frame: theme attribute, stylesheet injection and the mock warning.
 *
 * The mock banner is rendered from `adapter.isMock` and takes no prop, so an
 * integrator cannot configure it away while still showing fabricated numbers.
 */
export function WidgetShell(props: WidgetShellProps): ReactElement {
  const { theme, adapter } = useWidgetContext();
  /* Overlays portal into the widget itself, so they inherit its theme and
     stay inside a shadow root (see portal.tsx). */
  const [root, setRoot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    injectWidgetStyles();
  }, []);

  return (
    <PortalContainerProvider value={root}>
    <section
      ref={setRoot}
      className={`gullycore-widget${props.className ? ` ${props.className}` : ""}`}
      data-gullycore-theme={theme}
      data-gullycore-bare={props.bare === true ? "true" : undefined}
      aria-label={props.title}
    >
      {props.hideHeader === true ? (
        <h2 className="gullycore-visually-hidden">{props.title}</h2>
      ) : (
      <header className="gullycore-header">
        {props.headerContent !== undefined ? (
          <>
            <h2 className="gullycore-visually-hidden">{props.title}</h2>
            {props.headerContent}
          </>
        ) : (
          <div>
            <h2 className="gullycore-title">{props.title}</h2>
            {props.subtitle !== undefined ? (
              <p className="gullycore-subtitle">{props.subtitle}</p>
            ) : null}
          </div>
        )}
        {props.headerAction}
      </header>
      )}
      {adapter.isMock ? <MockBanner /> : null}
      {props.children}
    </section>
    </PortalContainerProvider>
  );
}

/** Permanent, non-dismissible warning shown whenever the adapter is a mock. */
export function MockBanner(): ReactElement {
  return (
    <div className="gullycore-mock-banner" role="note">
      <strong>Mock data</strong>
      <span>
        No contracts are deployed. Every price, balance and route shown here is
        simulated by the development adapter and is not a market quote.
      </span>
    </div>
  );
}

/** Props for {@link AmountField}. */
export interface AmountFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onValueChange?: (value: string) => void;
  readonly readOnly?: boolean;
  readonly token: TokenInfo | null;
  readonly tokens: readonly TokenInfo[];
  readonly onTokenChange?: (token: TokenInfo) => void;
  readonly balance?: bigint | null;
  readonly onUseMax?: () => void;
  readonly error?: string | null;
  readonly secondaryText?: string;
  readonly placeholder?: string;
}

/** An amount input paired with a token selector and a balance line. */
export function AmountField(props: AmountFieldProps): ReactElement {
  const inputId = useId();
  const selectId = useId();
  const errorId = useId();

  const handleAmount = (event: ChangeEvent<HTMLInputElement>): void => {
    props.onValueChange?.(event.target.value);
  };

  const handleToken = (event: ChangeEvent<HTMLSelectElement>): void => {
    const next = props.tokens.find((token) => token.address === event.target.value);
    if (next !== undefined) props.onTokenChange?.(next);
  };

  return (
    <div className="gullycore-field">
      <label className="gullycore-label" htmlFor={inputId}>
        {props.label}
      </label>
      <div className="gullycore-field-row">
        <input
          id={inputId}
          className="gullycore-amount-input"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder={props.placeholder ?? "0.0"}
          value={props.value}
          readOnly={props.readOnly ?? false}
          onChange={handleAmount}
          aria-invalid={props.error ? true : undefined}
          aria-describedby={props.error ? errorId : undefined}
        />
        <label className="gullycore-visually-hidden" htmlFor={selectId}>
          {`${props.label} token`}
        </label>
        <select
          id={selectId}
          className="gullycore-select"
          value={props.token?.address ?? ""}
          onChange={handleToken}
          disabled={props.onTokenChange === undefined}
        >
          {props.token === null ? <option value="">Select</option> : null}
          {props.tokens.map((token) => (
            <option key={token.address} value={token.address}>
              {token.symbol}
            </option>
          ))}
        </select>
      </div>
      <div className="gullycore-meta">
        <span>{props.secondaryText ?? ""}</span>
        {props.balance !== undefined && props.balance !== null && props.token !== null ? (
          <span className="gullycore-meta-value">
            Balance {formatAmount(props.balance, props.token.decimals)}
            {props.onUseMax !== undefined ? (
              <>
                {" "}
                <button
                  type="button"
                  className="gullycore-chip"
                  style={{ display: "inline", flex: "none", padding: "0 6px" }}
                  onClick={props.onUseMax}
                >
                  Max
                </button>
              </>
            ) : null}
          </span>
        ) : (
          <span />
        )}
      </div>
      {props.error ? (
        <p id={errorId} className="gullycore-status" data-gullycore-tone="error">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

/** One label/value pair inside a summary block. */
export interface SummaryRowProps {
  readonly label: string;
  readonly value: ReactNode;
  readonly emphasis?: "fee";
  readonly severity?: "low" | "elevated" | "high" | "severe" | "unknown";
  readonly title?: string;
}

/** A `<dt>`/`<dd>` pair. Must be rendered inside {@link SummaryList}. */
export function SummaryRow(props: SummaryRowProps): ReactElement {
  return (
    <div
      className="gullycore-summary-row"
      data-gullycore-emphasis={props.emphasis}
      data-gullycore-severity={props.severity}
    >
      <dt title={props.title}>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}

/** A definition list wrapper for {@link SummaryRow}s. */
export function SummaryList(props: { readonly children: ReactNode }): ReactElement {
  return (
    <div className="gullycore-summary">
      <dl>{props.children}</dl>
    </div>
  );
}

/** Props for {@link StatusRegion}. */
export interface StatusRegionProps {
  readonly message: string;
  readonly tone?: "neutral" | "error" | "success";
  /** `assertive` for errors that need to interrupt; `polite` otherwise. */
  readonly assertive?: boolean;
}

/**
 * The widget's single live region.
 *
 * Quote refreshes and transaction transitions are announced here rather than by
 * moving focus, so a keyboard user is never yanked out of the amount field
 * mid-typing by a background re-quote.
 */
export function StatusRegion(props: StatusRegionProps): ReactElement {
  return (
    <p
      className="gullycore-status"
      data-gullycore-tone={props.tone ?? "neutral"}
      role="status"
      aria-live={props.assertive === true ? "assertive" : "polite"}
    >
      {props.message}
    </p>
  );
}

/** Props for {@link ActionButton}. */
export interface ActionButtonProps {
  readonly children: ReactNode;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly type?: "button" | "submit";
  readonly variant?: "primary" | "secondary" | "danger";
  /**
   * True while the widget is waiting for a wallet. The button then becomes
   * the connect call to action: enabled and calling `onConnectRequest` when
   * the host gave one, otherwise the disabled label it always was. `type`,
   * `disabled` and `onClick` are ignored in that state.
   */
  readonly needsConnect?: boolean;
  /** See {@link connectCtaProps}. */
  readonly onConnectRequest?: () => void;
}

/**
 * The attributes of a primary button while no wallet is connected.
 *
 * With a handler the button is a real button that asks the host to open its
 * connect flow; without one it is disabled, so a host that renders its own
 * connect control somewhere else keeps exactly the behaviour it had. Never a
 * submit: pressing it must not run the form's swap/add/buy handler.
 */
export function connectCtaProps(onConnectRequest: (() => void) | undefined): {
  readonly type: "button";
  readonly disabled: boolean;
  readonly onClick: (() => void) | undefined;
} {
  return { type: "button", disabled: onConnectRequest === undefined, onClick: onConnectRequest };
}

/** The widget's primary call to action. */
export function ActionButton(props: ActionButtonProps): ReactElement {
  const connect = props.needsConnect === true ? connectCtaProps(props.onConnectRequest) : null;
  return (
    <button
      type={connect !== null ? connect.type : (props.type ?? "button")}
      className="gullycore-button"
      data-gullycore-variant={props.variant ?? "primary"}
      disabled={connect !== null ? connect.disabled : props.disabled === true || props.busy === true}
      aria-busy={props.busy === true ? true : undefined}
      onClick={connect !== null ? connect.onClick : props.onClick}
    >
      {props.children}
    </button>
  );
}

/** A labelled progress bar backed by a real `progressbar` role. */
export function ProgressBar(props: {
  readonly label: string;
  readonly percent: number;
}): ReactElement {
  const clamped = Math.max(0, Math.min(100, props.percent));
  return (
    <div
      className="gullycore-progress"
      role="progressbar"
      aria-label={props.label}
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="gullycore-progress-fill" style={{ width: `${clamped}%` }} />
    </div>
  );
}

/** A radio-style segmented control. */
export function SegmentedControl<T extends string>(props: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onChange: (value: T) => void;
}): ReactElement {
  const groupLabelId = useId();
  return (
    <>
      <span id={groupLabelId} className="gullycore-visually-hidden">
        {props.label}
      </span>
      <div className="gullycore-tabs" role="tablist" aria-labelledby={groupLabelId}>
        {props.options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="tab"
            className="gullycore-chip"
            aria-selected={option.value === props.value}
            tabIndex={option.value === props.value ? 0 : -1}
            onClick={() => props.onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </>
  );
}

/** Renders a route as a chain of token chips. */
export function RouteSummary(props: {
  readonly tokens: readonly string[];
  readonly detail?: string;
}): ReactElement {
  const chips = useMemo(
    () =>
      props.tokens.flatMap((symbol, index) => {
        const chip = (
          <span key={`token-${symbol}-${index}`} className="gullycore-route-token">
            {symbol}
          </span>
        );
        return index === 0
          ? [chip]
          : [
              <span key={`arrow-${index}`} aria-hidden="true">
                {"→"}
              </span>,
              chip,
            ];
      }),
    [props.tokens],
  );

  return (
    <div className="gullycore-route">
      {chips}
      {props.detail !== undefined ? <span>{props.detail}</span> : null}
    </div>
  );
}

/** An error panel with `role="alert"`. */
export function ErrorPanel(props: { readonly error: Error | null; readonly context?: "quote" | "swap" | "liquidity" | "transaction" }): ReactElement | null {
  if (props.error === null) return null;
  /* The raw error (viem's multi-paragraph report, the package tag) is for
     logs; the panel prints one sentence a trader can act on. */
  return (
    <div className="gullycore-error" role="alert">
      {describeError(props.error, props.context)}
    </div>
  );
}
