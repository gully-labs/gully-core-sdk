// SPDX-License-Identifier: MIT
/**
 * `useDraft`: a builder form that survives a reload.
 *
 * On mount it offers the saved draft (the caller decides whether to restore
 * it; a form that is already half typed is never overwritten silently). On
 * every change it saves, debounced, stripping the chain's answers
 * (`lib/draft.ts`). The caller clears it when the create confirms.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { clearDraft, loadDraft, saveDraft, type DraftOutcome } from "./draft";

export interface DraftHandle<T extends object> {
  /** The draft found on mount, or `null`; cleared once restored or discarded. */
  readonly found: { readonly form: Partial<T>; readonly savedAt: number } | null;
  /** Outcome of the last save: `null` before the first one. `'blocked'` / `'full'` are stated, never thrown. */
  readonly lastSave: DraftOutcome | null;
  /** Apply the found draft and forget the offer. */
  readonly restore: () => Partial<T> | null;
  /** Keep the current form and forget the offer. */
  readonly discard: () => void;
  /** Delete the stored draft (a confirmed create). */
  readonly clear: () => void;
}

const SAVE_DELAY_MS = 400;

export function useDraft<T extends object>(key: string | null, form: T, accept: (raw: Record<string, unknown>) => Partial<T>, enabled = true): DraftHandle<T> {
  const [found, setFound] = useState<{ form: Partial<T>; savedAt: number } | null>(() => (key === null ? null : loadDraft<T>(key, accept)));
  const [lastSave, setLastSave] = useState<DraftOutcome | null>(null);
  const first = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (key === null || !enabled) return;
    /* The initial form is the template's own; saving it would overwrite a found draft before the creator decides. */
    if (first.current) {
      first.current = false;
      return;
    }
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setLastSave(saveDraft(key, form)), SAVE_DELAY_MS);
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [key, form, enabled]);

  const restore = useCallback((): Partial<T> | null => {
    const f = found;
    setFound(null);
    first.current = false;
    return f === null ? null : f.form;
  }, [found]);
  const discard = useCallback(() => setFound(null), []);
  const clear = useCallback(() => {
    if (key !== null) clearDraft(key);
    setFound(null);
    setLastSave(null);
  }, [key]);

  return { found, lastSave, restore, discard, clear };
}
