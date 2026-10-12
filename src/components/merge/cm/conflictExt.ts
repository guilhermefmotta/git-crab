/**
 * CodeMirror extension that highlights conflict marker regions in the center
 * (merged) document and inserts phantom blank lines for alignment.
 */
import {
  Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType,
} from "@codemirror/view";
import { Range } from "@codemirror/state";
import { StateEffect, StateField } from "@codemirror/state";
import type { ConflictStatus } from "@/lib/mergeTypes";

// ── Conflict range in the center document ────────────────────────────────────

export interface ConflictRange {
  /** 0-based index in the original parsed conflict list */
  idx: number;
  /** Positions in the current document */
  markerFrom: number;   // start of <<<<<<< line
  markerTo: number;     // end of >>>>>>> line (inclusive \n)
  oursFrom: number;     // first char of ours content
  oursTo: number;       // last char of ours content (before =======)
  sepFrom: number;      // start of ======= line
  theirsFrom: number;   // first char of theirs content
  theirsTo: number;     // last char of theirs content (before >>>>>>>)
  status: ConflictStatus;
}

// ── Parse conflicts in current document ─────────────────────────────────────

export function parseConflictRanges(doc: string): Omit<ConflictRange, "idx" | "status">[] {
  const ranges: Omit<ConflictRange, "idx" | "status">[] = [];
  const lines = doc.split("\n");
  let pos = 0;
  let i = 0;

  while (i < lines.length) {
    if (lines[i].startsWith("<<<<<<<")) {
      const markerFrom = pos;
      pos += lines[i].length + 1;
      i++;
      const oursFrom = pos;

      while (i < lines.length && !lines[i].startsWith("=======")) {
        pos += lines[i].length + 1;
        i++;
      }
      const oursTo = pos - 1;
      const sepFrom = pos;
      pos += (lines[i]?.length ?? 7) + 1;
      i++;
      const theirsFrom = pos;

      while (i < lines.length && !lines[i].startsWith(">>>>>>>")) {
        pos += lines[i].length + 1;
        i++;
      }
      const theirsTo = pos - 1;
      const markerTo = pos + (lines[i]?.length ?? 7) + 1;
      pos += (lines[i]?.length ?? 7) + 1;
      i++;

      ranges.push({ markerFrom, markerTo, oursFrom, oursTo, sepFrom, theirsFrom, theirsTo });
    } else {
      pos += lines[i].length + 1;
      i++;
    }
  }
  return ranges;
}

// ── Conflict blocks tracked through edits ────────────────────────────────────

/**
 * Where each original conflict lives in the center document, kept in place by
 * mapping through every change (accepting a side, typing, undo). Index i is
 * always original conflict i, unlike re-parsing markers, which renumbers the
 * remaining conflicts once one is resolved.
 */
export interface ConflictBlock { from: number; to: number }

export const setConflictBlocks = StateEffect.define<ConflictBlock[]>();

export const conflictBlocksField = StateField.define<ConflictBlock[]>({
  create: () => [],
  update(blocks, tr) {
    for (const e of tr.effects) if (e.is(setConflictBlocks)) return e.value;
    if (!tr.docChanged) return blocks;
    // Start sticks left and end sticks right, so text replacing the whole
    // block (or appended at its end) stays inside it
    return blocks.map(b => {
      const from = tr.changes.mapPos(b.from, -1);
      return { from, to: Math.max(from, tr.changes.mapPos(b.to, 1)) };
    });
  },
});

// ── StateEffect to update conflict info ──────────────────────────────────────

export const setConflictRanges = StateEffect.define<ConflictRange[]>();

export const conflictRangesField = StateField.define<ConflictRange[]>({
  create: () => [],
  update(ranges, tr) {
    for (const e of tr.effects) {
      if (e.is(setConflictRanges)) return e.value;
    }
    if (!tr.docChanged) return ranges;
    // Map positions through the change
    return ranges.map(r => ({
      ...r,
      markerFrom:  tr.changes.mapPos(r.markerFrom),
      markerTo:    tr.changes.mapPos(r.markerTo),
      oursFrom:    tr.changes.mapPos(r.oursFrom),
      oursTo:      tr.changes.mapPos(r.oursTo),
      sepFrom:     tr.changes.mapPos(r.sepFrom),
      theirsFrom:  tr.changes.mapPos(r.theirsFrom),
      theirsTo:    tr.changes.mapPos(r.theirsTo),
    }));
  },
});

// ── Phantom line widget ───────────────────────────────────────────────────────

class PhantomWidget extends WidgetType {
  constructor(readonly heightPx: number) { super(); }
  eq(other: PhantomWidget) { return other.heightPx === this.heightPx; }
  toDOM() {
    const el = document.createElement("div");
    el.style.height = `${this.heightPx}px`;
    el.style.background = "transparent";
    el.className = "cm-phantom";
    return el;
  }
  ignoreEvent() { return true; }
}

// ── StateEffect for phantom lines ────────────────────────────────────────────

export interface PhantomSpec { pos: number; height: number }
export const setPhantomLines = StateEffect.define<PhantomSpec[]>();
export const phantomLinesField = StateField.define<PhantomSpec[]>({
  create: () => [],
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setPhantomLines)) return e.value;
    return v;
  },
});

// ── Decoration plugin for center pane (line decorations only — no block) ─────

export const centerConflictPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) { this.decorations = this.build(view); }

  update(update: ViewUpdate) {
    if (update.docChanged || update.transactions.some(t => t.effects.length > 0)) {
      this.decorations = this.build(update.view);
    }
  }

  build(view: EditorView): DecorationSet {
    const ranges = view.state.field(conflictRangesField);
    const decos: Range<Decoration>[] = [];
    const doc = view.state.doc;

    for (const r of ranges) {
      if (r.markerFrom >= doc.length || r.markerTo > doc.length) continue;

      if (r.status === "unresolved") {
        const mLine = doc.lineAt(r.markerFrom);
        decos.push(Decoration.line({ class: "cm-conflict-marker" }).range(mLine.from));
        const oStart = doc.lineAt(r.oursFrom);
        const oEnd   = doc.lineAt(Math.max(r.oursFrom, r.oursTo - 1));
        for (let l = oStart.number; l <= oEnd.number; l++) {
          decos.push(Decoration.line({ class: "cm-conflict-ours" }).range(doc.line(l).from));
        }
        const sLine = doc.lineAt(r.sepFrom);
        decos.push(Decoration.line({ class: "cm-conflict-sep" }).range(sLine.from));
        const tStart = doc.lineAt(r.theirsFrom);
        const tEnd   = doc.lineAt(Math.max(r.theirsFrom, r.theirsTo - 1));
        for (let l = tStart.number; l <= tEnd.number; l++) {
          decos.push(Decoration.line({ class: "cm-conflict-theirs" }).range(doc.line(l).from));
        }
        const eLine = doc.lineAt(Math.min(r.markerTo - 1, doc.length - 1));
        decos.push(Decoration.line({ class: "cm-conflict-marker" }).range(eLine.from));
      } else {
        if (r.markerTo <= r.markerFrom) continue; // resolved to nothing
        const cls =
          r.status === "ours"    ? "cm-resolved-ours"
          : r.status === "theirs"  ? "cm-resolved-theirs"
          : r.status === "both"    ? "cm-resolved-both"
          : "cm-resolved-manual";
        const resolvedStart = doc.lineAt(r.markerFrom);
        const resolvedEnd   = doc.lineAt(Math.min(r.markerTo - 1, doc.length - 1));
        for (let l = resolvedStart.number; l <= resolvedEnd.number; l++) {
          decos.push(Decoration.line({ class: cls }).range(doc.line(l).from));
        }
      }
    }

    decos.sort((a, b) => a.from - b.from);
    return Decoration.set(decos, true);
  }
}, { decorations: v => v.decorations });

// ── Phantom block decorations for center pane (StateField — block allowed) ────

export const centerPhantomDecoField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(_deco, tr) {
    const phantoms = tr.state.field(phantomLinesField);
    const doc = tr.state.doc;
    const decos: Range<Decoration>[] = [];
    for (const ph of phantoms) {
      const safePos = Math.min(ph.pos, doc.length);
      decos.push(
        Decoration.widget({ widget: new PhantomWidget(ph.height), side: 1, block: true })
          .range(safePos),
      );
    }
    decos.sort((a, b) => a.from - b.from);
    return Decoration.set(decos, true);
  },
  provide: f => EditorView.decorations.from(f),
});

// ── Side-pane highlight plugin (read-only left/right) ────────────────────────

export interface SidePaneConflict {
  startLine: number; // 1-based, inclusive
  endLine: number;   // 1-based, inclusive
  side: "ours" | "theirs";
  phantomAfter: number; // height in px to add after endLine
}

export const setSidePaneConflicts = StateEffect.define<SidePaneConflict[]>();
export const sidePaneConflictsField = StateField.define<SidePaneConflict[]>({
  create: () => [],
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setSidePaneConflicts)) return e.value;
    return v;
  },
});

export const sidePanePlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) { this.decorations = this.build(view); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.transactions.some(t => t.effects.length > 0)) {
      this.decorations = this.build(update.view);
    }
  }

  build(view: EditorView): DecorationSet {
    const conflicts = view.state.field(sidePaneConflictsField);
    const doc = view.state.doc;
    const decos: Range<Decoration>[] = [];

    for (const c of conflicts) {
      const cls = c.side === "ours" ? "cm-conflict-ours" : "cm-conflict-theirs";
      const safeEnd = Math.min(c.endLine, doc.lines);
      for (let l = c.startLine; l <= safeEnd; l++) {
        try {
          decos.push(Decoration.line({ class: cls }).range(doc.line(l).from));
        } catch {}
      }
    }

    decos.sort((a, b) => a.from - b.from);
    return Decoration.set(decos, true);
  }
}, { decorations: v => v.decorations });

// ── Phantom block decorations for side panes (StateField — block allowed) ─────

export const sidePanePhantomDecoField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(_deco, tr) {
    const conflicts = tr.state.field(sidePaneConflictsField);
    const doc = tr.state.doc;
    const decos: Range<Decoration>[] = [];
    for (const c of conflicts) {
      if (c.phantomAfter > 0) {
        try {
          const endPos = doc.line(Math.min(c.endLine, doc.lines)).to;
          decos.push(
            Decoration.widget({ widget: new PhantomWidget(c.phantomAfter), side: 1, block: true })
              .range(endPos),
          );
        } catch {}
      }
    }
    decos.sort((a, b) => a.from - b.from);
    return Decoration.set(decos, true);
  },
  provide: f => EditorView.decorations.from(f),
});
