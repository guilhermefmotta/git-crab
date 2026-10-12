import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { Toaster, toast } from "sonner";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { EditorState, EditorSelection } from "@codemirror/state";
import { defaultKeymap, historyKeymap, history, indentWithTab } from "@codemirror/commands";
import {
  search, searchKeymap, highlightSelectionMatches, SearchQuery, setSearchQuery, openSearchPanel,
} from "@codemirror/search";
import { appTheme, appHighlight } from "@/components/merge/cm/theme";
import { getLanguage } from "@/components/merge/cm/lang";
import { git } from "@/lib/tauri";
import { useEscapeToClose } from "@/hooks/useEscapeToClose";

const STORAGE_PREFIX = "git_rust_editor_";

export interface EditorMeta {
  repoPath: string;
  filePath: string;
  /** Branch/ref to read from; the file is then shown read-only */
  rev?: string;
  /** 1-based line to jump to, with the search term to highlight there */
  line?: number;
  query?: string;
  caseSensitive?: boolean;
  /** Changes on every request so re-opening an already-open window re-jumps */
  nonce?: number;
}

// appTheme is tuned for the merge panes (no gutters, page-level scrolling);
// a standalone editor needs its own scroller and line numbers
const editorTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "12px" },
  // Extra `.cm-editor` beats appTheme's equally-specific `overflow: visible !important`
  "&.cm-editor .cm-scroller": { overflow: "auto !important" },
  "&.cm-editor .cm-gutters": {
    display: "flex !important",
    background: "hsl(222 47% 10%)",
    borderRight: "1px solid hsl(217 32% 17%)",
    color: "hsl(220 10% 45%)",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px", minWidth: "44px" },
  ".cm-activeLine": { background: "rgba(255,255,255,.03)" },
  ".cm-activeLineGutter": { background: "rgba(255,255,255,.05)", color: "hsl(210 40% 80%)" },

  // ── Search (Ctrl/Cmd+F) ──
  ".cm-searchMatch": {
    background: "rgba(250,204,21,.22)",
    outline: "1px solid rgba(250,204,21,.45)",
    borderRadius: "2px",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    background: "rgba(249,115,22,.55)",
    outline: "1px solid rgb(251,146,60)",
    boxShadow: "0 0 6px rgba(249,115,22,.6)",
  },
  ".cm-selectionMatch": { background: "rgba(59,130,246,.18)", borderRadius: "2px" },
  ".cm-panels": {
    background: "hsl(222 47% 13%)",
    color: "hsl(210 40% 90%)",
    borderColor: "hsl(217 32% 20%) !important",
  },
  ".cm-panel.cm-search": {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "6px",
    padding: "6px 36px 6px 10px",
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    fontSize: "11px",
  },
  ".cm-panel.cm-search br": { display: "none" },
  ".cm-panel.cm-search input[type=checkbox]": { accentColor: "rgb(59,130,246)", marginRight: "3px" },
  ".cm-panel.cm-search label": { display: "inline-flex", alignItems: "center", color: "hsl(215 20% 65%)", fontSize: "11px" },
  ".cm-textfield": {
    background: "hsl(222 47% 8%)",
    border: "1px solid hsl(217 32% 22%)",
    borderRadius: "4px",
    color: "inherit",
    padding: "3px 8px",
    fontSize: "12px",
    outline: "none",
    minWidth: "200px",
  },
  ".cm-textfield:focus": { borderColor: "rgb(59,130,246)", boxShadow: "0 0 0 1px rgba(59,130,246,.5)" },
  ".cm-button": {
    backgroundImage: "none",
    background: "hsl(217 32% 20%)",
    border: "1px solid hsl(217 32% 26%)",
    borderRadius: "4px",
    color: "inherit",
    padding: "3px 8px",
    fontSize: "11px",
    cursor: "pointer",
  },
  ".cm-button:hover": { background: "hsl(217 32% 26%)" },
  ".cm-panel.cm-search button[name=close]": {
    color: "hsl(215 20% 65%)",
    fontSize: "16px",
    right: "10px",
    top: "50%",
    transform: "translateY(-50%)",
    cursor: "pointer",
  },
});

export default function EditorWindow({ storageKey }: { storageKey: string }) {
  const [meta, setMeta] = useState<EditorMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const savedRef = useRef("");
  const [viewReady, setViewReady] = useState(0);

  useEffect(() => {
    const load = () => {
      try {
        const raw = localStorage.getItem(`${STORAGE_PREFIX}${storageKey}`);
        if (!raw) { setError("No file to open"); setLoading(false); return; }
        setMeta(JSON.parse(raw));
      } catch {
        setError("Failed to load editor data");
        setLoading(false);
      }
    };
    load();
    // The main window rewrites our key when a search result in an already-open
    // file is clicked; `storage` fires here (other window) so we can re-jump
    const onStorage = (e: StorageEvent) => {
      if (e.key === `${STORAGE_PREFIX}${storageKey}`) load();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [storageKey]);

  const readOnly = !!meta?.rev;
  const fileId = meta ? JSON.stringify([meta.repoPath, meta.filePath, meta.rev ?? null]) : null;

  const save = useCallback(async () => {
    const view = viewRef.current;
    if (!view || !meta || meta.rev) return;
    const content = view.state.doc.toString();
    setSaving(true);
    try {
      await git.writeFileContent(meta.repoPath, meta.filePath, content);
      savedRef.current = content;
      setDirty(false);
      toast.success("Saved");
    } catch (e) {
      toast.error(`Save failed: ${e}`);
    } finally {
      setSaving(false);
    }
  }, [meta]);

  // Esc closes the window; with unsaved edits the first Esc only warns
  const escArmedRef = useRef(0);
  useEscapeToClose(true, () => {
    if (!dirty) return true;
    if (Date.now() - escArmedRef.current < 2000) return true;
    escArmedRef.current = Date.now();
    toast.warning("Unsaved changes — press Esc again to discard and close");
    return false;
  });

  // Keep the keymap's save handler pointing at the latest `save`
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (!meta || !containerRef.current) return;
    let view: EditorView | null = null;
    let cancelled = false;

    const load = meta.rev
      ? git.getFileAtRef(meta.repoPath, meta.rev, meta.filePath)
      : git.getFileContent(meta.repoPath, meta.filePath);
    load
      .then((content) => {
        if (cancelled || !containerRef.current) return;
        savedRef.current = content;
        const lang = getLanguage(meta.filePath);
        view = new EditorView({
          state: EditorState.create({
            doc: content,
            extensions: [
              appTheme,
              editorTheme,
              appHighlight,
              EditorState.readOnly.of(!!meta.rev),
              lineNumbers(),
              highlightActiveLine(),
              highlightActiveLineGutter(),
              history(),
              search({ top: true }),
              highlightSelectionMatches(),
              keymap.of([
                { key: "Mod-s", preventDefault: true, run: () => { saveRef.current(); return true; } },
                indentWithTab,
                ...searchKeymap,
                ...defaultKeymap,
                ...historyKeymap,
              ]),
              EditorView.updateListener.of((u) => {
                if (u.docChanged) setDirty(u.state.doc.toString() !== savedRef.current);
              }),
              ...(lang ? [lang] : []),
            ],
          }),
          parent: containerRef.current,
        });
        viewRef.current = view;
        view.focus();
        setViewReady((n) => n + 1);
      })
      .catch((e) => setError(String(e)))
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => {
      cancelled = true;
      view?.destroy();
      viewRef.current = null;
    };
    // Only reload when the file itself changes, not on a new jump target
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId]);

  // Jump to the requested line and highlight the search term (all occurrences
  // via the search panel, the one on that line selected)
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !meta?.line) return;
    const doc = view.state.doc;
    const line = doc.line(Math.min(Math.max(meta.line, 1), doc.lines));
    let anchor = line.from;
    let head = line.from;
    if (meta.query) {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({
        search: meta.query, caseSensitive: !!meta.caseSensitive, literal: true,
      })) });
      openSearchPanel(view);
      const hay = meta.caseSensitive ? line.text : line.text.toLowerCase();
      const idx = hay.indexOf(meta.caseSensitive ? meta.query : meta.query.toLowerCase());
      if (idx >= 0) { anchor = line.from + idx; head = anchor + meta.query.length; }
    }
    view.dispatch({
      selection: EditorSelection.single(anchor, head),
      effects: EditorView.scrollIntoView(anchor, { y: "center" }),
    });
    view.focus();
  }, [viewReady, meta?.line, meta?.query, meta?.caseSensitive, meta?.nonce]);

  useEffect(() => {
    if (meta) document.title = `${dirty ? "● " : ""}${meta.filePath}${meta.rev ? ` @ ${meta.rev}` : ""}`;
  }, [meta, dirty]);

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border shrink-0">
        <span className="flex-1 truncate text-xs font-mono">
          {meta?.filePath}
          {meta?.rev && (
            <span className="ml-2 px-1.5 py-0.5 rounded bg-green-500/20 text-green-400 text-[10px]">
              {meta.rev} · read-only
            </span>
          )}
          {dirty && <span className="ml-2 text-yellow-400">● modified</span>}
        </span>
        {!readOnly && (
        <button
          data-testid="editor-save"
          onClick={save}
          disabled={!dirty || saving}
          className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-primary/20 text-primary hover:bg-primary/30 transition-colors disabled:opacity-40"
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
          Save
        </button>
        )}
      </div>
      {error ? (
        <p className="p-4 text-xs text-red-400">{error}</p>
      ) : (
        <div className="relative flex-1 min-h-0">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 size={16} className="animate-spin text-muted-foreground" />
            </div>
          )}
          <div ref={containerRef} className="h-full" />
        </div>
      )}
      <Toaster position="bottom-right" theme="dark" />
    </div>
  );
}
