import { EditorView, GutterMarker, gutter } from "@codemirror/view";
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { formatDistanceToNow } from "date-fns";
import type { LineAuthor } from "@/lib/types";

// Inline blame ("who changed this line"): a gutter left of the line numbers
// labelling each run of lines from the same commit with author + age. Lines
// with no commit (uncommitted edits) stay blank.

export const setLineAuthors = StateEffect.define<(LineAuthor | null)[]>();

const authorsField = StateField.define<(LineAuthor | null)[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setLineAuthors)) return e.value;
    return value;
  },
});

// Stable per-commit tint so neighbouring blocks are easy to tell apart
const TINTS = ["#60a5fa", "#a78bfa", "#34d399", "#fbbf24", "#f472b6", "#22d3ee", "#fb923c", "#2dd4bf"];
function tint(hash: string): string {
  let h = 0;
  for (let i = 0; i < 8; i++) h = (h * 31 + hash.charCodeAt(i)) | 0;
  return TINTS[Math.abs(h) % TINTS.length];
}

class AuthorMarker extends GutterMarker {
  constructor(readonly info: LineAuthor, readonly first: boolean) { super(); }
  eq(o: AuthorMarker) { return o.info.hash === this.info.hash && o.first === this.first; }
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-blame-entry";
    el.style.borderLeftColor = tint(this.info.hash);
    const date = new Date(this.info.timestamp * 1000);
    el.title = `${this.info.author} · ${date.toLocaleString()}\n${this.info.short_hash} ${this.info.summary}`;
    if (this.first) {
      const who = document.createElement("span");
      who.className = "cm-blame-author";
      who.textContent = this.info.author;
      const when = document.createElement("span");
      when.className = "cm-blame-age";
      when.textContent = formatDistanceToNow(date, { addSuffix: true });
      el.append(who, when);
    }
    return el;
  }
}

class Spacer extends GutterMarker {
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-blame-entry";
    el.textContent = " ";
    return el;
  }
}

const theme = EditorView.theme({
  ".cm-blame-gutter": { width: "220px", background: "hsl(222 47% 9%)", borderRight: "1px solid hsl(217 32% 17%)" },
  ".cm-blame-gutter .cm-gutterElement": { padding: "0" },
  ".cm-blame-entry": {
    display: "flex", gap: "6px", height: "100%", padding: "0 8px 0 6px",
    borderLeft: "2px solid transparent", fontSize: "11px", overflow: "hidden", whiteSpace: "nowrap",
  },
  ".cm-blame-author": { color: "hsl(210 40% 80%)", overflow: "hidden", textOverflow: "ellipsis", flex: "1" },
  ".cm-blame-age": { color: "hsl(215 20% 55%)", flexShrink: "0" },
});

export function blameGutter(): Extension {
  return [
    authorsField,
    gutter({
      class: "cm-blame-gutter",
      lineMarker(view, line) {
        const authors = view.state.field(authorsField);
        const n = view.state.doc.lineAt(line.from).number;
        const info = authors[n - 1];
        if (!info) return null;
        // Name only at the start of each run of lines from the same commit
        return new AuthorMarker(info, authors[n - 2]?.hash !== info.hash);
      },
      lineMarkerChange: (u) => u.transactions.some((tr) => tr.effects.some((e) => e.is(setLineAuthors))),
      initialSpacer: () => new Spacer(),
    }),
    theme,
  ];
}
