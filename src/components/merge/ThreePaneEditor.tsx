/**
 * IntelliJ-style 3-pane merge editor.
 *
 * Left  (read-only): full `ours` content, conflict lines highlighted green.
 * Center (editable): full merged document with CodeMirror. Conflict marker
 *                    blocks are highlighted. Like IntelliJ, each side can be
 *                    applied independently: the first replaces the markers,
 *                    the second is appended below, and ✕ ignores a side
 *                    without taking anything from it; the result stays editable
 *                    and "Done" writes + stages the file.
 * Right (read-only): full `theirs` content, conflict lines highlighted blue.
 *
 * Phantom lines keep all three panes the same total height so a single outer
 * scroll container aligns them perfectly.
 */

import {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import { EditorView } from "@codemirror/view";
import {
  ChevronsLeft, ChevronsRight, ChevronDown, ChevronUp,
  CheckCircle, SkipForward, Loader2, Undo2, Redo2, X,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { git } from "@/lib/tauri";
import { parseSegments } from "@/lib/conflictParser";
import type { ConflictContent, ConflictStatus } from "@/lib/mergeTypes";
import { getLanguage } from "./cm/lang";
import {
  conflictRangesField, centerConflictPlugin, centerPhantomDecoField, setConflictRanges,
  conflictBlocksField, setConflictBlocks, type ConflictBlock,
  phantomLinesField, setPhantomLines, parseConflictRanges,
  sidePaneConflictsField, sidePanePlugin, sidePanePhantomDecoField, setSidePaneConflicts,
  type ConflictRange, type SidePaneConflict,
} from "./cm/conflictExt";
import { makeReadonlyEditor, makeEditableEditor } from "./cm/editor";
import { undo, redo, undoDepth, redoDepth } from "@codemirror/commands";

// ── Constants ─────────────────────────────────────────────────────────────────

const LINE_H = 20;

// Conflict marker lines. "=======" alone isn't checked: it's also a Markdown
// heading underline.
const MARKER_RE = /^(<<<<<<<|>>>>>>>)/m;

/** What happened to one side of one conflict */
type SideState = "pending" | "applied" | "ignored";
type Applied = { ours: SideState; theirs: SideState };
const PENDING: Applied = { ours: "pending", theirs: "pending" };

// ── ThreePaneEditor ───────────────────────────────────────────────────────────

export interface ThreePaneEditorProps {
  repoPath: string;
  filePath: string;
  content: ConflictContent;
  onStaged: () => void;
  onSkip: () => void;
}

export function ThreePaneEditor({
  repoPath, filePath, content, onStaged, onSkip,
}: ThreePaneEditorProps) {
  // ── Refs for CM editors ──────────────────────────────────────────────────────
  const leftRef    = useRef<HTMLDivElement>(null);
  const centerRef  = useRef<HTMLDivElement>(null);
  const rightRef   = useRef<HTMLDivElement>(null);
  const leftView   = useRef<EditorView | null>(null);
  const centerView = useRef<EditorView | null>(null);
  const rightView  = useRef<EditorView | null>(null);

  // ── State ──────────────────────────────────────────────────────────────────
  const [centerDoc, setCenterDoc] = useState(content.merged);
  const [activeConflict, setActiveConflict] = useState(0);
  const [staging, setStaging] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo]  = useState(false);

  // Initial segment parse for ours/theirs line ranges (fixed at load time)
  const segs = useMemo(() => parseSegments(content.merged), [content.merged]);

  // ── Parse conflict ranges from initial segments ───────────────────────────
  const initialConflicts = useMemo(() => {
    const res: Array<{
      idx: number;
      oursLines: string[];
      theirsLines: string[];
      ourLabel: string;
      theirLabel: string;
    }> = [];
    for (const seg of segs) {
      if (seg.kind === "conflict") {
        res.push(seg.section);
      }
    }
    return res;
  }, [segs]);

  const total = initialConflicts.length;

  // ── Compute ours/theirs line ranges in the side panes ────────────────────
  const sideRanges = useMemo(() => {
    let oursLine = 1, theirsLine = 1;
    const oursConflicts: SidePaneConflict[]   = [];
    const theirsConflicts: SidePaneConflict[] = [];

    for (const seg of segs) {
      if (seg.kind === "context") {
        oursLine   += seg.lines.length;
        theirsLine += seg.lines.length;
      } else {
        const { oursLines, theirsLines } = seg.section;
        oursConflicts.push({
          startLine: oursLine,
          endLine: oursLine + oursLines.length - 1,
          side: "ours",
          phantomAfter: 0, // computed below
        });
        theirsConflicts.push({
          startLine: theirsLine,
          endLine: theirsLine + theirsLines.length - 1,
          side: "theirs",
          phantomAfter: 0,
        });
        oursLine   += oursLines.length;
        theirsLine += theirsLines.length;
      }
    }
    return { oursConflicts, theirsConflicts };
  }, [segs]);

  // ── Per-conflict state ─────────────────────────────────────────────────────
  // Which sides were applied to each conflict, and where each conflict block
  // currently sits in the center doc (mirrors conflictBlocksField).
  const [applied, setApplied] = useState<Applied[]>(
    () => initialConflicts.map(() => PENDING),
  );
  const [blocks, setBlocks] = useState<ConflictBlock[]>([]);

  const blockInfo = useMemo(() => blocks.map((b, i) => {
    const text = centerDoc.slice(b.from, b.to);
    const a = applied[i] ?? PENDING;
    const ours = a.ours === "applied", theirs = a.theirs === "applied";
    const status: ConflictStatus =
      MARKER_RE.test(text) ? "unresolved"
      : ours && theirs ? "both"
      : ours ? "ours"
      : theirs ? "theirs"
      : "manual";
    const lines = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    return { ...b, text, status, lines };
  }), [blocks, centerDoc, applied]);

  // Undo back to the marker block makes both sides available again
  useEffect(() => {
    const touched = (a?: Applied) => !!a && (a.ours !== "pending" || a.theirs !== "pending");
    if (blockInfo.some((b, i) => b.status === "unresolved" && touched(applied[i]))) {
      setApplied(prev => prev.map((a, i) => blockInfo[i]?.status === "unresolved" ? PENDING : a));
    }
  }, [blockInfo]);

  const conflictStateMap = useMemo(
    () => new Map(blockInfo.map((b, i) => [i, b.status] as const)),
    [blockInfo],
  );

  const resolvedCount = useMemo(
    () => blockInfo.filter(b => b.status !== "unresolved").length,
    [blockInfo],
  );
  const allDone = resolvedCount === total; // total=0 means diffy resolved cleanly

  // ── Compute phantom lines for alignment ───────────────────────────────────
  const phantomData = useMemo(() => {
    // For each conflict i:
    // center_lines_i = current line count in center for this conflict
    // ours_lines_i = fixed
    // theirs_lines_i = fixed
    // max_i = max of all three
    // phantom_left_i = max_i - ours_lines_i
    // phantom_right_i = max_i - theirs_lines_i
    // phantom_center_i = max_i - center_lines_i (added after conflict region)

    const oursPhantoms: Array<{ afterEndLine: number; height: number }>   = [];
    const theirsPhantoms: Array<{ afterEndLine: number; height: number }> = [];
    const centerPhantoms: Array<{ pos: number; height: number }>          = [];

    for (let i = 0; i < initialConflicts.length; i++) {
      const ic = initialConflicts[i];
      const oursLines   = ic.oursLines.length;
      const theirsLines = ic.theirsLines.length;
      const block = blockInfo[i];
      const centerLines = block ? block.lines : Math.max(oursLines, theirsLines);

      const maxLines = Math.max(oursLines, theirsLines, centerLines, 1);

      // Left phantom (add after ours conflict region)
      const oursConfl = sideRanges.oursConflicts[i];
      if (oursConfl && maxLines > oursLines) {
        oursPhantoms.push({ afterEndLine: oursConfl.endLine, height: (maxLines - oursLines) * LINE_H });
      }

      // Right phantom (add after theirs conflict region)
      const theirsConfl = sideRanges.theirsConflicts[i];
      if (theirsConfl && maxLines > theirsLines) {
        theirsPhantoms.push({ afterEndLine: theirsConfl.endLine, height: (maxLines - theirsLines) * LINE_H });
      }

      // Center phantom (after the conflict block, when it is the shortest)
      if (block && maxLines > centerLines) {
        centerPhantoms.push({ pos: block.to, height: (maxLines - centerLines) * LINE_H });
      }
    }

    return { oursPhantoms, theirsPhantoms, centerPhantoms };
  }, [blockInfo, initialConflicts, sideRanges]);

  // ── Initialize CM editors ─────────────────────────────────────────────────
  useEffect(() => {
    if (!leftRef.current || !centerRef.current || !rightRef.current) return;

    const lang = getLanguage(filePath);
    const sharedExtras = lang ? [lang] : [];

    // Left pane
    leftView.current = makeReadonlyEditor(leftRef.current, content.ours, [
      ...sharedExtras,
      sidePaneConflictsField,
      sidePanePhantomDecoField,
      sidePanePlugin,
    ]);

    // Center pane
    centerView.current = makeEditableEditor(centerRef.current, content.merged, [
      ...sharedExtras,
      conflictRangesField,
      conflictBlocksField,
      phantomLinesField,
      centerPhantomDecoField,
      centerConflictPlugin,
    ], (doc) => {
      setCenterDoc(doc);
      const cv = centerView.current;
      if (cv) setBlocks(cv.state.field(conflictBlocksField));
    });

    const initialBlocks: ConflictBlock[] = parseConflictRanges(content.merged).map(r => ({
      from: r.markerFrom,
      to: Math.min(r.markerTo, content.merged.length),
    }));
    centerView.current.dispatch({ effects: setConflictBlocks.of(initialBlocks) });
    setBlocks(initialBlocks);

    // Right pane
    rightView.current = makeReadonlyEditor(rightRef.current, content.theirs, [
      ...sharedExtras,
      sidePaneConflictsField,
      sidePanePhantomDecoField,
      sidePanePlugin,
    ]);

    return () => {
      leftView.current?.destroy();
      centerView.current?.destroy();
      rightView.current?.destroy();
    };
  }, [filePath, content]);

  // ── Update CM decorations when centerDoc or phantoms change ───────────────
  useEffect(() => {
    const cv = centerView.current;
    if (!cv) return;

    const ranges: ConflictRange[] = blockInfo.map((b, i) => {
      if (b.status === "unresolved") {
        const inner = parseConflictRanges(b.text)[0];
        if (inner) {
          return {
            idx: i, status: "unresolved",
            markerFrom: b.from + inner.markerFrom, markerTo: Math.min(b.from + inner.markerTo, b.to),
            oursFrom: b.from + inner.oursFrom,     oursTo: b.from + inner.oursTo,
            sepFrom: b.from + inner.sepFrom,
            theirsFrom: b.from + inner.theirsFrom, theirsTo: b.from + inner.theirsTo,
          };
        }
      }
      return {
        idx: i, status: b.status === "unresolved" ? "manual" : b.status,
        markerFrom: b.from, markerTo: b.to,
        oursFrom: b.from, oursTo: b.from, sepFrom: b.from, theirsFrom: b.from, theirsTo: b.from,
      };
    });

    cv.dispatch({
      effects: [
        setConflictRanges.of(ranges),
        setPhantomLines.of(phantomData.centerPhantoms),
      ],
    });
  }, [blockInfo, phantomData]);

  // ── Update side pane decorations ──────────────────────────────────────────
  useEffect(() => {
    const lv = leftView.current;
    const rv = rightView.current;
    if (!lv || !rv) return;

    const oursWithPhantoms: SidePaneConflict[] = sideRanges.oursConflicts.map(c => ({
      ...c,
      phantomAfter: phantomData.oursPhantoms.find(p => p.afterEndLine === c.endLine)?.height ?? 0,
    }));
    const theirsWithPhantoms: SidePaneConflict[] = sideRanges.theirsConflicts.map(c => ({
      ...c,
      phantomAfter: phantomData.theirsPhantoms.find(p => p.afterEndLine === c.endLine)?.height ?? 0,
    }));

    lv.dispatch({ effects: [setSidePaneConflicts.of(oursWithPhantoms)] });
    rv.dispatch({ effects: [setSidePaneConflicts.of(theirsWithPhantoms)] });
  }, [sideRanges, phantomData]);

  // ── Scroll sync ───────────────────────────────────────────────────────────
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const cv = centerView.current;
    const lv = leftView.current;
    const rv = rightView.current;
    const container = scrollContainerRef.current;
    if (!cv || !lv || !rv || !container) return;

    let syncing = false;
    const onCenterScroll = () => {
      if (syncing) return;
      syncing = true;
      requestAnimationFrame(() => {
        const top = cv.scrollDOM.scrollTop;
        lv.scrollDOM.scrollTop = top;
        rv.scrollDOM.scrollTop = top;
        container.scrollTop = top;
        syncing = false;
      });
    };
    const onSideScroll = (src: EditorView) => () => {
      if (syncing) return;
      syncing = true;
      requestAnimationFrame(() => {
        const top = src.scrollDOM.scrollTop;
        cv.scrollDOM.scrollTop = top;
        lv.scrollDOM.scrollTop = top;
        rv.scrollDOM.scrollTop = top;
        syncing = false;
      });
    };

    cv.scrollDOM.addEventListener("scroll", onCenterScroll, { passive: true });
    lv.scrollDOM.addEventListener("scroll", onSideScroll(lv), { passive: true });
    rv.scrollDOM.addEventListener("scroll", onSideScroll(rv), { passive: true });
    return () => {
      cv.scrollDOM.removeEventListener("scroll", onCenterScroll);
      lv.scrollDOM.removeEventListener("scroll", onSideScroll(lv));
      rv.scrollDOM.removeEventListener("scroll", onSideScroll(rv));
    };
  }, []);

  // ── Apply one side to conflict i (IntelliJ-style) ─────────────────────────
  // First side applied replaces the marker block; applying the other side
  // afterwards appends it below whatever the block holds by then.
  const applySide = (cv: EditorView, idx: number, side: "ours" | "theirs"): boolean => {
    const b  = cv.state.field(conflictBlocksField)[idx];
    const ic = initialConflicts[idx];
    if (!b || !ic) return false;

    const text = (side === "ours" ? ic.oursLines : ic.theirsLines).join("\n");
    const doc = cv.state.doc;
    const blockText = doc.sliceString(b.from, b.to);

    if (MARKER_RE.test(blockText)) {
      // The block ends after the >>>>>>> line's newline; keep that newline
      const insert = text && blockText.endsWith("\n") ? text + "\n" : text;
      cv.dispatch({ changes: { from: b.from, to: b.to, insert } });
    } else if (text) {
      let insert: string;
      if (blockText.endsWith("\n")) insert = text + "\n";
      else if (blockText) insert = "\n" + text;
      else if (b.to < doc.length) insert = text + "\n";
      else insert = b.from > 0 && doc.sliceString(b.from - 1, b.from) !== "\n" ? "\n" + text : text;
      cv.dispatch({ changes: { from: b.to, insert } });
    }
    return true;
  };

  // Accept (apply) or ignore one side of a conflict. Ignoring a side of a block
  // that still has markers drops the markers (and both texts), leaving the
  // other side available to accept or ignore.
  const handleSide = useCallback((conflictIdx: number, side: "ours" | "theirs", action: "accept" | "ignore") => {
    const cv = centerView.current;
    if (!cv) return;
    const before = cv.state.field(conflictBlocksField)[conflictIdx];
    if (!before) return;
    const wasUnresolved = MARKER_RE.test(cv.state.sliceDoc(before.from, before.to));

    if (action === "accept") {
      if (!applySide(cv, conflictIdx, side)) return;
    } else if (wasUnresolved) {
      cv.dispatch({ changes: { from: before.from, to: before.to, insert: "" } });
    }
    setApplied(prev => prev.map((a, i) =>
      i === conflictIdx ? { ...a, [side]: action === "accept" ? "applied" : "ignored" } : a));

    // After the first decision, move on to the next conflict still showing markers
    if (wasUnresolved) {
      const now = cv.state.field(conflictBlocksField);
      for (let j = conflictIdx + 1; j < now.length; j++) {
        if (MARKER_RE.test(cv.state.sliceDoc(now[j].from, now[j].to))) {
          setActiveConflict(j);
          cv.dispatch({ effects: EditorView.scrollIntoView(now[j].from, { y: "center" }) });
          break;
        }
      }
    }
  }, [initialConflicts]);

  // ── Navigate to conflict i ────────────────────────────────────────────────
  const goToConflict = useCallback((i: number) => {
    const cv = centerView.current;
    if (!cv) return;

    const clamped = Math.max(0, Math.min(total - 1, i));
    setActiveConflict(clamped);

    // Scroll center to the conflict position
    const ranges = cv.state.field(conflictRangesField);
    const r = ranges[clamped];
    if (r) {
      cv.dispatch({ effects: EditorView.scrollIntoView(r.markerFrom, { y: "center" }) });
    }
  }, [total]);

  const goToNextUnresolved = useCallback(() => {
    const cv = centerView.current;
    if (!cv) return;
    const ranges = cv.state.field(conflictRangesField);
    if (ranges.length === 0) return;
    // Find next unresolved after activeConflict
    for (let d = 1; d <= total; d++) {
      const i = (activeConflict + d) % ranges.length;
      const r = ranges[i];
      if (r && r.status === "unresolved") {
        setActiveConflict(i);
        cv.dispatch({ effects: EditorView.scrollIntoView(r.markerFrom, { y: "center" }) });
        return;
      }
    }
  }, [activeConflict, total]);

  // Accept all one side (only conflicts still showing markers)
  const acceptAll = (kind: "ours" | "theirs") => {
    const cv = centerView.current;
    if (!cv) return;
    const done: number[] = [];
    const count = cv.state.field(conflictBlocksField).length;
    for (let i = 0; i < count; i++) {
      const b = cv.state.field(conflictBlocksField)[i];
      if (MARKER_RE.test(cv.state.sliceDoc(b.from, b.to)) && applySide(cv, i, kind)) done.push(i);
    }
    setApplied(prev => prev.map((a, i) => done.includes(i) ? { ...a, [kind]: "applied" } : a));
  };

  // ── Update undo/redo availability ─────────────────────────────────────────
  useEffect(() => {
    const cv = centerView.current;
    if (!cv) return;
    setCanUndo(undoDepth(cv.state) > 0);
    setCanRedo(redoDepth(cv.state) > 0);
  }, [centerDoc]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        const cv = centerView.current;
        if (cv) undo(cv);
        return;
      }
      if (mod && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
        e.preventDefault();
        const cv = centerView.current;
        if (cv) redo(cv);
        return;
      }
      if (mod && e.key === "ArrowDown") { e.preventDefault(); goToNextUnresolved(); }
      if (mod && e.key === "ArrowUp")   { e.preventDefault(); goToConflict(activeConflict - 1); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [activeConflict, goToConflict, goToNextUnresolved]);

  // ── Done: write result, stage, parent moves to the next file ──────────────
  const stage = async () => {
    const cv = centerView.current;
    if (!cv || staging) return;
    const doc = cv.state.doc.toString();

    if (MARKER_RE.test(doc)) {
      toast.error("Unresolved conflict markers remain");
      return;
    }
    setStaging(true);
    try {
      await git.resolveConflict(repoPath, filePath, doc);
      toast.success(`Resolved: ${filePath}`);
      onStaged();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setStaging(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  const unresolvedTotal = total - resolvedCount;

  // Ctrl/Cmd+Enter = Done
  const stageRef = useRef(stage);
  stageRef.current = stage;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); stageRef.current(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  return (
    <div className="flex flex-col h-full overflow-hidden font-mono">

      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-card shrink-0 flex-wrap">
        <span className="text-xs text-muted-foreground truncate flex-1 min-w-0 font-mono">{filePath}</span>

        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={() => { const cv = centerView.current; if (cv) undo(cv); }}
            disabled={!canUndo}
            title="Undo (Ctrl+Z)"
            className="p-1 rounded text-muted-foreground hover:text-foreground disabled:opacity-30 hover:bg-accent/30 transition-colors"
          >
            <Undo2 size={12} />
          </button>
          <button
            onClick={() => { const cv = centerView.current; if (cv) redo(cv); }}
            disabled={!canRedo}
            title="Redo (Ctrl+Y)"
            className="p-1 rounded text-muted-foreground hover:text-foreground disabled:opacity-30 hover:bg-accent/30 transition-colors"
          >
            <Redo2 size={12} />
          </button>
        </div>

        {total > 1 && (
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={() => acceptAll("ours")} data-testid="all-ours-btn"
              className="flex items-center gap-0.5 px-2 py-1 text-[10px] rounded border bg-green-900/30 border-green-700/30 text-green-300 hover:bg-green-900/50 transition-colors">
              <ChevronsRight size={10} /> All Local
            </button>
            <button onClick={() => acceptAll("theirs")} data-testid="all-theirs-btn"
              className="flex items-center gap-0.5 px-2 py-1 text-[10px] rounded border bg-blue-900/30 border-blue-700/30 text-blue-300 hover:bg-blue-900/50 transition-colors">
              <ChevronsLeft size={10} /> All Remote
            </button>
          </div>
        )}

        <div className="flex items-center gap-0.5 shrink-0">
          <button onClick={() => goToConflict(activeConflict - 1)} disabled={activeConflict === 0} data-testid="prev-conflict-btn"
            className="p-1 rounded text-muted-foreground hover:text-foreground disabled:opacity-30 hover:bg-accent/30 transition-colors">
            <ChevronUp size={12} />
          </button>
          <span data-testid="conflict-progress" className="text-[10px] tabular-nums text-muted-foreground px-1 min-w-[72px] text-center">
            {total - unresolvedTotal}/{total} resolved
          </span>
          <button onClick={() => goToConflict(activeConflict + 1)} disabled={activeConflict >= total - 1} data-testid="next-conflict-btn"
            className="p-1 rounded text-muted-foreground hover:text-foreground disabled:opacity-30 hover:bg-accent/30 transition-colors">
            <ChevronDown size={12} />
          </button>
        </div>

        <button onClick={stage} disabled={!allDone || staging} data-testid="stage-btn"
          title="Write the result, stage it and go to the next conflicted file (Ctrl/Cmd+Enter)"
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0">
          {staging && <Loader2 size={11} className="animate-spin" />}
          {staging ? "Saving…" : <><CheckCircle size={11} /> Done</>}
        </button>

        <button onClick={onSkip}
          className="flex items-center gap-1 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground border border-border/40 rounded hover:bg-accent/20 transition-colors shrink-0">
          <SkipForward size={11} /> Skip
        </button>
      </div>

      {/* Column headers */}
      <div className="grid grid-cols-3 shrink-0 bg-card border-b border-border text-[10px] font-semibold uppercase tracking-wider">
        <div className="px-3 py-1.5 text-green-400/80">Local (Ours)</div>
        <div className="px-3 py-1.5 text-muted-foreground border-x border-border/20">
          Result <span className="normal-case font-normal text-muted-foreground/40 ml-1">— editable</span>
        </div>
        <div className="px-3 py-1.5 text-blue-400/80">Remote (Theirs)</div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 relative" ref={scrollContainerRef}>
        <div className="grid grid-cols-3 min-h-full">
          {/* Left pane — Accept Local button on the right edge */}
          <div className="relative overflow-hidden border-r border-border/20">
            <div ref={leftRef} />
            <SidePaneOverlay
              paneView={leftView}
              conflicts={sideRanges.oursConflicts}
              applied={applied}
              side="ours"
              onActivate={setActiveConflict}
              onSide={handleSide}
            />
          </div>

          {/* Center pane — editable result */}
          <div className="relative overflow-hidden border-x border-border/20">
            <div ref={centerRef} />
          </div>

          {/* Right pane — Accept Remote button on the left edge */}
          <div className="relative overflow-hidden border-l border-border/20">
            <div ref={rightRef} />
            <SidePaneOverlay
              paneView={rightView}
              conflicts={sideRanges.theirsConflicts}
              applied={applied}
              side="theirs"
              onActivate={setActiveConflict}
              onSide={handleSide}
            />
          </div>
        </div>
      </div>

      {/* Footer minimap */}
      <div className="flex items-center gap-1.5 px-4 py-2 border-t border-border bg-card shrink-0">
        {initialConflicts.map((ic, i) => {
          const isResolved = (conflictStateMap.get(ic.idx) ?? "unresolved") !== "unresolved";
          return (
            <button key={ic.idx} onClick={() => goToConflict(i)}
              title={`Conflict ${i + 1}`}
              className={cn("w-2 h-2 rounded-full transition-all hover:scale-125",
                isResolved          ? "bg-green-500"
                : i === activeConflict ? "bg-yellow-400 scale-125"
                : "bg-yellow-700/50 hover:bg-yellow-500/60"
              )} />
          );
        })}
        <span className="text-[10px] text-muted-foreground flex-1 text-right">
          {allDone
            ? total === 0
              ? "No conflicts — click Done"
              : "All resolved — click Done (Ctrl+Enter) for the next file"
            : `${unresolvedTotal} conflict${unresolvedTotal !== 1 ? "s" : ""} remaining`}
        </span>
      </div>
    </div>
  );
}

// ── Accept button overlaid on side panes ─────────────────────────────────────

function SidePaneOverlay({
  paneView, conflicts, applied, side, onActivate, onSide,
}: {
  paneView: React.RefObject<EditorView | null>;
  conflicts: SidePaneConflict[];
  applied: Applied[];
  side: "ours" | "theirs";
  onActivate: (i: number) => void;
  onSide: (i: number, side: "ours" | "theirs", action: "accept" | "ignore") => void;
}) {
  const [positions, setPositions] = useState<{ top: number; idx: number }[]>([]);

  useEffect(() => {
    const view = paneView.current;
    if (!view) return;

    const update = () => {
      const newPos = conflicts.map((c, i) => {
        try {
          const startLine = Math.max(1, Math.min(c.startLine, view.state.doc.lines));
          const lineFrom = view.state.doc.line(startLine).from;
          return { top: view.lineBlockAt(lineFrom).top, idx: i };
        } catch { return null; }
      }).filter(Boolean) as { top: number; idx: number }[];
      setPositions(newPos);
    };

    update();
    const obs = new MutationObserver(update);
    obs.observe(view.dom, { childList: true, subtree: true });
    view.scrollDOM.addEventListener("scroll", update, { passive: true });
    return () => { obs.disconnect(); view.scrollDOM.removeEventListener("scroll", update); };
  }, [paneView, conflicts]);

  const isOurs = side === "ours";

  return (
    <>
      {positions.map(({ top, idx }) => {
        const pos = { position: "absolute" as const, top, [isOurs ? "right" : "left"]: 0, zIndex: 10 };
        const state = applied[idx]?.[side] ?? "pending";

        // Decided sides show what was done; pending ones offer Accept / Ignore
        if (state !== "pending") {
          return (
            <div key={idx} style={pos} title={state === "applied" ? "Accepted" : "Ignored"}>
              <div className={cn(
                "px-1.5 py-0.5 border text-[9px]",
                state === "applied" ? "bg-green-950/70 border-green-700/20" : "bg-secondary/70 border-border/40",
              )}>
                {state === "applied"
                  ? <CheckCircle size={8} className="text-green-400" />
                  : <X size={8} className="text-muted-foreground" />}
              </div>
            </div>
          );
        }

        const accept = (
          <button
            key="accept"
            data-testid={`accept-${side}-${idx}`}
            onClick={() => { onActivate(idx); onSide(idx, side, "accept"); }}
            title={isOurs ? "Accept Local (ours)" : "Accept Remote (theirs)"}
            className={cn(
              "flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-medium transition-colors",
              isOurs
                ? "text-green-400 hover:text-green-200 hover:bg-green-900/60"
                : "text-blue-400 hover:text-blue-200 hover:bg-blue-900/60",
            )}
          >
            {isOurs
              ? <><ChevronsRight size={9} /> Accept</>
              : <>Accept <ChevronsLeft size={9} /></>}
          </button>
        );
        const ignore = (
          <button
            key="ignore"
            data-testid={`ignore-${side}-${idx}`}
            onClick={() => { onActivate(idx); onSide(idx, side, "ignore"); }}
            title={isOurs ? "Ignore Local (ours) — don't take anything from this side" : "Ignore Remote (theirs) — don't take anything from this side"}
            className="flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground hover:text-red-300 hover:bg-red-900/40 transition-colors"
          >
            <X size={9} /> Ignore
          </button>
        );

        return (
          <div
            key={idx}
            style={pos}
            className={cn(
              "flex items-center bg-card/90 backdrop-blur shadow-sm border divide-x divide-border/40",
              isOurs ? "border-green-700/30 rounded-br" : "border-blue-700/30 rounded-bl",
            )}
          >
            {/* Ignore sits on the outer edge, Accept next to the result pane */}
            {isOurs ? [ignore, accept] : [accept, ignore]}
          </div>
        );
      })}
    </>
  );
}
