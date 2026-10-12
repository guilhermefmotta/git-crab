import { EditorView, Decoration, DecorationSet, GutterMarker, gutter } from "@codemirror/view";
import { RangeSet, RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import type { LineChange } from "@/lib/types";

// VS Code-style "dirty diff": coloured bars in a thin gutter next to the line
// numbers plus a faint line tint, for lines added/modified vs HEAD, and a red
// wedge where lines were deleted.

class ChangeMarker extends GutterMarker {
  constructor(readonly kind: LineChange["kind"]) { super(); }
  eq(other: ChangeMarker) { return other.kind === this.kind; }
  toDOM() {
    const el = document.createElement("div");
    el.className = `cm-change-${this.kind}`;
    return el;
  }
}

const markers = {
  added: new ChangeMarker("added"),
  modified: new ChangeMarker("modified"),
  deleted: new ChangeMarker("deleted"),
};

const lineDecos = {
  added: Decoration.line({ class: "cm-changed-line-added" }),
  modified: Decoration.line({ class: "cm-changed-line-modified" }),
};

export const setLineChanges = StateEffect.define<LineChange[]>();

interface ChangeState {
  gutter: RangeSet<GutterMarker>;
  lines: DecorationSet;
}

function build(view: { doc: EditorView["state"]["doc"] }, changes: LineChange[]): ChangeState {
  const doc = view.doc;
  const g = new RangeSetBuilder<GutterMarker>();
  const d = new RangeSetBuilder<Decoration>();
  // Ranges are reported in order; builders need ascending positions
  for (const c of changes) {
    if (c.kind === "deleted") {
      // Marker goes on the line following the removed block, at its top edge
      const line = doc.line(Math.min(c.start + 1, doc.lines));
      g.add(line.from, line.from, markers.deleted);
      continue;
    }
    for (let n = Math.max(c.start, 1); n <= Math.min(c.end, doc.lines); n++) {
      const line = doc.line(n);
      g.add(line.from, line.from, markers[c.kind]);
      d.add(line.from, line.from, lineDecos[c.kind]);
    }
  }
  return { gutter: g.finish(), lines: d.finish() };
}

const changeField = StateField.define<ChangeState>({
  create: () => ({ gutter: RangeSet.empty, lines: Decoration.none }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setLineChanges)) return build(tr.state, e.value);
    }
    // Keep markers attached to their lines while typing until the next refresh
    return tr.docChanged
      ? { gutter: value.gutter.map(tr.changes), lines: value.lines.map(tr.changes) }
      : value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.lines),
});

const theme = EditorView.theme({
  ".cm-change-gutter": { width: "4px", paddingLeft: "2px" },
  ".cm-change-gutter .cm-gutterElement": { padding: "0" },
  ".cm-change-added, .cm-change-modified": { width: "3px", height: "100%" },
  ".cm-change-added": { background: "rgb(74,222,128)" },
  ".cm-change-modified": { background: "rgb(250,204,21)" },
  // Wedge sitting on the boundary where lines disappeared
  ".cm-change-deleted": {
    width: 0, height: 0,
    borderTop: "4px solid transparent",
    borderBottom: "4px solid transparent",
    borderLeft: "5px solid rgb(248,113,113)",
    transform: "translateY(-4px)",
  },
  ".cm-changed-line-added": { background: "rgba(74,222,128,.07)" },
  ".cm-changed-line-modified": { background: "rgba(250,204,21,.06)" },
});

export function lineChanges(): Extension {
  return [
    changeField,
    gutter({
      class: "cm-change-gutter",
      markers: (view) => view.state.field(changeField).gutter,
    }),
    theme,
  ];
}
