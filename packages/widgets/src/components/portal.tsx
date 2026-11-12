// SPDX-License-Identifier: MIT
/**
 * Where overlays render. Radix portals default to `document.body`, which is
 * outside a shadow root and outside the `.gullycore-widget` theme scope. The shell
 * provides its own element instead, so dialogs and popovers inherit the theme
 * variables and stay styled inside the web component.
 */

import { createContext, useContext } from "react";

const PortalContainerContext = createContext<HTMLElement | null>(null);

export const PortalContainerProvider = PortalContainerContext.Provider;

/** The element overlays should portal into, or `undefined` for Radix's default. */
export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainerContext) ?? undefined;
}
