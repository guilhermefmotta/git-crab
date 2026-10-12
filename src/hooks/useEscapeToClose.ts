import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Closes the current (secondary) window on Escape. Skipped when something
 * else already handled the key (e.g. CodeMirror closing its search panel) or
 * a dialog is open. `confirmClose` can veto the close, e.g. for unsaved edits.
 */
export function useEscapeToClose(enabled = true, confirmClose?: () => boolean) {
  const confirmRef = useRef(confirmClose);
  confirmRef.current = confirmClose;

  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      if (confirmRef.current && !confirmRef.current()) return;
      e.preventDefault();
      getCurrentWindow().close().catch(() => {});
    };
    // Bubble phase so editor/dialog handlers get the key first
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled]);
}
