// SPDX-License-Identifier: MIT
/**
 * Framework-agnostic embedding.
 *
 * Two escape hatches for hosts that are not React:
 *
 * - **Custom elements** - `<gullycore-swap-widget>`, `<gullycore-liquidity-widget>` and
 *   `<gullycore-launch-widget>`, rendered into a shadow root. Works anywhere a
 *   browser runs, including plain HTML.
 * - **`<gullycore-lock-badge>`** - the read-only lock badge as plain DOM, no React
 *   and no wallet; {@link defineGullyCoreLockBadge} registers it. The standalone
 *   `gullycore-embed.js` bundle registers it on load for pages with no bundler.
 * - **Iframe bridge** - the widget runs in its own realm and asks the host page
 *   to perform every chain read and write over a documented postMessage
 *   contract. For hosts that will not execute third-party script in their realm.
 *
 * Importing this module does not register anything. Call
 * {@link defineGullyCoreWidgets} when you want the elements defined.
 *
 * @packageDocumentation
 */

export {
  defineGullyCoreWidgets,
  WIDGET_TAG_NAMES,
  GullyCoreSwapWidgetElement,
  GullyCoreLiquidityWidgetElement,
  GullyCoreLaunchWidgetElement,
} from "./embed/webComponent.js";

export {
  WIDGET_CHANNEL,
  WIDGET_PROTOCOL_VERSION,
  createIframeBridgeAdapter,
  reportWidgetHeight,
  serveWidgetIframe,
  type BridgeMethod,
  type HostInitMessage,
  type HostMessage,
  type HostResultMessage,
  type IframeBridgeOptions,
  type ServeWidgetIframeOptions,
  type WidgetEventMessage,
  type WidgetInvokeMessage,
  type WidgetMessage,
  type WidgetReadyMessage,
  type WidgetResizeMessage,
} from "./embed/iframe.js";

export {
  LOCK_BADGE_TAG,
  GullyCoreLockBadgeElement,
  defineGullyCoreLockBadge,
  parseLockBadgeAttributes,
} from "./embed/lockBadge.js";

export { BUYS_TAG, parseBuysAttributes, buysSnippet, type BuysAttributes, type BuysLayout, type BuysTheme } from "./buys/model.js";
export { GullyBuysElement, defineGullyBuys, BUYS_CSS } from "./buys/element.js";
export { BuysSource, type BuysState } from "./buys/source.js";

export { WIDGET_CSS, injectWidgetStyles } from "./styles/css.js";
