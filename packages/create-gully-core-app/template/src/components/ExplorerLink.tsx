// SPDX-License-Identifier: MIT
/**
 * The one way this app renders a block-explorer link. `href` comes from
 * `explorerTxUrl` / `explorerAddressUrl` (lib/client.ts), which return `null`
 * when the chain has no explorer (`chain.explorer: ""`, or a local devnet); the
 * content is then shown as plain text rather than linked to the real chain.
 */

import type { ReactElement, ReactNode } from "react";

export function ExplorerLink({
  href,
  className,
  title,
  children,
}: {
  href: string | null;
  className?: string;
  title?: string;
  children: ReactNode;
}): ReactElement {
  if (href === null) {
    return (
      <span className={className} title={title ?? "No block explorer is configured for this chain"}>
        {children}
      </span>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className} title={title}>
      {children}
    </a>
  );
}
