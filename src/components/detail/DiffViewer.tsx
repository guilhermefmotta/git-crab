import { useEffect, useMemo, useRef, useState } from "react";
import { EditorView, lineNumbers } from "@codemirror/view";
import { EditorState, StateField, StateEffect, RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet } from "@codemirror/view";
import { appTheme, appHighlight } from "@/components/merge/cm/theme";
import { getLanguage } from "@/components/merge/cm/lang";
import type { FileDiff, DiffLine } from "@/lib/types";

// ── Row model ────────────────────────────────────────────────────────────────

type RowSide = {
  content: string;
  lineNo: number | null;
  type: "context" | "add" | "delete" | "empty";
};

type Row = { left: RowSide; right: RowSide };

function buildRows(lines: DiffLine[]): Row[] {
  const rows: Row[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.line_type === "header") { i++; continue; }
    if (line.line_type === "context") {
      rows.push({
        left:  { content: line.content, lineNo: line.old_lineno, type: "context" },
        right: { content: line.content, lineNo: line.new_lineno, type: "context" },
      });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].line_type === "delete") dels.push(lines[i++]);
    while (i < lines.length && lines[i].line_type === "add")    adds.push(lines[i++]);
    const maxLen = Math.max(dels.length, adds.length);
    for (let j = 0; j < maxLen; j++) {
      rows.push({
        left:  dels[j]
          ? { content: dels[j].content, lineNo: dels[j].old_lineno, type: "delete" }
          : { content: "",              lineNo: null,                type: "empty" },
        right: adds[j]
          ? { content: adds[j].content, lineNo: adds[j].new_lineno, type: "add" }
          : { content: "",              lineNo: null,                type: "empty" },
      });
    }
  }
  return rows;
}

// ── Static decoration StateField ──────────────────────────────────────────────

const setDecos = StateEffect.define<DecorationSet>();

const staticDecoField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (val, tr) => {
    for (const e of tr.effects) if (e.is(setDecos)) return e.value;
    return val;
  },
  provide: f => EditorView.decorations.from(f),
});

// ── Diff theme extension ───────────────────────────────────────────────────────

const diffTheme = EditorView.theme({
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "40px",
    textAlign: "right",
    padding: "0 6px",
    color: "hsl(220 10% 45%)",
    fontSize: "10px",
    lineHeight: "20px",
    userSelect: "none",
  },
  ".cm-lineNumbers": {
    borderRight: "1px solid hsl(217 32% 17%)",
    background: "hsl(222 47% 10%)",
    minWidth: "44px",
  },
  ".cm-diff-delete": { background: "rgba(239,68,68,.15)", borderLeft: "2px solid rgba(239,68,68,.4)" },
  ".cm-diff-add":    { background: "rgba(34,197,94,.13)", borderLeft: "2px solid rgba(34,197,94,.35)" },
  ".cm-diff-empty":  { background: "rgba(255,255,255,.02)" },
  "&": { height: "auto" },
  ".cm-scroller": { overflow: "visible !important" },
  ".cm-content": { lineHeight: "20px" },
  ".cm-line":    { padding: "0 6px", lineHeight: "20px" },
  // appTheme hides gutters (merge editor draws its own); the diff needs them
  ".cm-gutters": { borderRight: "none", display: "flex !important" },
});

// ── Build side doc + decorations ──────────────────────────────────────────────

function buildSide(rows: Row[], side: "left" | "right"): {
  doc: string;
  lineNos: (number | null)[];
  decos: DecorationSet;
} {
  const lines: string[] = [];
  const lineNos: (number | null)[] = [];
  const builder = new RangeSetBuilder<Decoration>();

  let pos = 0;
  for (const row of rows) {
    const s = side === "left" ? row.left : row.right;
    const cls =
      s.type === "delete" ? "cm-diff-delete" :
      s.type === "add"    ? "cm-diff-add"    :
      s.type === "empty"  ? "cm-diff-empty"  : null;
    if (cls) builder.add(pos, pos, Decoration.line({ class: cls }));
    lines.push(s.content);
    lineNos.push(s.lineNo);
    pos += s.content.length + 1; // +1 for \n
  }

  return { doc: lines.join("\n"), lineNos, decos: builder.finish() };
}

// ── Patch builder ─────────────────────────────────────────────────────────────

function buildHunkPatch(filePath: string, header: string, lines: DiffLine[]): string {
  const body = lines
    .filter((l) => l.line_type !== "header")
    .map((l) => {
      if (l.line_type === "add")    return `+${l.content}`;
      if (l.line_type === "delete") return `-${l.content}`;
      return ` ${l.content}`;
    })
    .join("\n");
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    header,
    body,
    "",
  ].join("\n");
}

// ── HunkView ──────────────────────────────────────────────────────────────────

interface HunkViewProps {
  filePath: string;
  header: string;
  showHeader: boolean;
  lines: DiffLine[];
  onStageHunk?: (patch: string) => Promise<void>;
  onUnstageHunk?: (patch: string) => Promise<void>;
}

function HunkView({ filePath, header, showHeader, lines, onStageHunk, onUnstageHunk }: HunkViewProps) {
  // Memoized so parent re-renders don't tear down and rebuild both editors
  const rows = useMemo(() => buildRows(lines), [lines]);
  const [staging, setStaging] = useState(false);
  const leftRef  = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!leftRef.current || !rightRef.current) return;

    const lang = getLanguage(filePath);
    const extraExts = lang ? [lang] : [];

    const leftData  = buildSide(rows, "left");
    const rightData = buildSide(rows, "right");

    const makeEditor = (
      parent: HTMLElement,
      doc: string,
      lineNos: (number | null)[],
      decos: DecorationSet,
    ) => new EditorView({
      state: EditorState.create({
        doc,
        extensions: [
          appTheme,
          diffTheme,
          appHighlight,
          EditorState.readOnly.of(true),
          staticDecoField.init(() => decos),
          lineNumbers({
            formatNumber: (lineNo) => {
              const n = lineNos[lineNo - 1];
              return n != null ? String(n) : "·";
            },
          }),
          ...extraExts,
        ],
      }),
      parent,
    });

    const left  = makeEditor(leftRef.current,  leftData.doc,  leftData.lineNos,  leftData.decos);
    const right = makeEditor(rightRef.current, rightData.doc, rightData.lineNos, rightData.decos);

    // Scroll sync
    let syncing = false;
    const sync = (src: EditorView, dst: EditorView) => {
      const top = src.scrollDOM.scrollTop;
      if (!syncing && Math.abs(dst.scrollDOM.scrollTop - top) > 1) {
        syncing = true;
        dst.scrollDOM.scrollTop = top;
        syncing = false;
      }
    };
    const lh = () => sync(left, right);
    const rh = () => sync(right, left);
    left.scrollDOM.addEventListener("scroll", lh, { passive: true });
    right.scrollDOM.addEventListener("scroll", rh, { passive: true });

    return () => {
      left.scrollDOM.removeEventListener("scroll", lh);
      right.scrollDOM.removeEventListener("scroll", rh);
      left.destroy();
      right.destroy();
    };
  }, [rows, filePath]);

  const handleStage = async () => {
    if (!lines || !onStageHunk) return;
    setStaging(true);
    try { await onStageHunk(buildHunkPatch(filePath, header, lines)); }
    finally { setStaging(false); }
  };

  const handleUnstage = async () => {
    if (!lines || !onUnstageHunk) return;
    setStaging(true);
    try { await onUnstageHunk(buildHunkPatch(filePath, header, lines)); }
    finally { setStaging(false); }
  };

  return (
    <div>
      {(showHeader || onStageHunk || onUnstageHunk) && (
      <div className="flex items-center gap-2 px-3 py-0.5 bg-blue-950/30 border-y border-blue-900/30">
        <span className="flex-1 text-blue-400/70 text-[10px] font-mono">{showHeader ? header : ""}</span>
        {onStageHunk && lines && (
          <button
            onClick={handleStage}
            disabled={staging}
            className="shrink-0 text-[10px] px-2 py-0.5 rounded bg-green-800/50 text-green-300 hover:bg-green-700/60 transition-colors disabled:opacity-40"
          >
            Stage Hunk
          </button>
        )}
        {onUnstageHunk && lines && (
          <button
            onClick={handleUnstage}
            disabled={staging}
            className="shrink-0 text-[10px] px-2 py-0.5 rounded bg-yellow-800/50 text-yellow-300 hover:bg-yellow-700/60 transition-colors disabled:opacity-40"
          >
            Unstage Hunk
          </button>
        )}
      </div>
      )}
      <div className="flex overflow-hidden">
        <div ref={leftRef}  className="flex-1 min-w-0 overflow-hidden border-r border-border/30" />
        <div ref={rightRef} className="flex-1 min-w-0 overflow-hidden" />
      </div>
    </div>
  );
}

// ── Public DiffViewer ─────────────────────────────────────────────────────────

interface DiffViewerProps {
  diff: FileDiff[];
  loading?: boolean;
  onStageHunk?: (filePath: string, patch: string) => Promise<void>;
  onUnstageHunk?: (filePath: string, patch: string) => Promise<void>;
}

export function DiffViewer({ diff, loading, onStageHunk, onUnstageHunk }: DiffViewerProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-xs text-muted-foreground">Loading diff…</p>
      </div>
    );
  }

  if (diff.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-xs text-muted-foreground">Select a file to view diff</p>
      </div>
    );
  }

  return (
    <div className="overflow-auto h-full font-mono text-[11px]">
      {diff.map((file) => (
        <div key={file.path}>
          <div className="sticky top-0 z-10 bg-secondary px-3 py-1 text-xs font-semibold text-foreground border-b border-border flex items-center">
            <span className="flex-1 truncate">{file.path}</span>
          </div>
          {file.hunks.map((hunk, hi) => (
            <HunkView
              key={hi}
              filePath={file.path}
              header={hunk.header}
              showHeader={file.hunks.length > 1}
              lines={hunk.lines}
              onStageHunk={onStageHunk ? (patch) => onStageHunk(file.path, patch) : undefined}
              onUnstageHunk={onUnstageHunk ? (patch) => onUnstageHunk(file.path, patch) : undefined}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
