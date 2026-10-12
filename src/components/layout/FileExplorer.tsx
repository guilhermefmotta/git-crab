import { useCallback, useEffect, useMemo, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { git } from "@/lib/tauri";
import { useAppStore } from "@/store/appStore";
import type { FileChange, TreeFile } from "@/lib/types";
import { openFileInEditor } from "@/components/dialogs/QuickOpenDialog";

// VS Code-style colours and badge letters per change kind
const CHANGE_STYLE: Record<FileChange, { letter: string; label: string; text: string }> = {
  modified:   { letter: "M", label: "Modified",            text: "text-yellow-400" },
  added:      { letter: "A", label: "Added (staged)",      text: "text-green-400" },
  untracked:  { letter: "U", label: "Untracked (new)",     text: "text-green-400" },
  deleted:    { letter: "D", label: "Deleted",             text: "text-red-400" },
  renamed:    { letter: "R", label: "Renamed",             text: "text-sky-400" },
  conflicted: { letter: "!", label: "Conflicted",          text: "text-purple-400" },
};

// When a folder holds several kinds of change, show the most important one
const PRIORITY: FileChange[] = ["conflicted", "deleted", "modified", "renamed", "added", "untracked"];

interface DirNode {
  name: string;
  path: string;
  dirs: Map<string, DirNode>;
  files: TreeFile[];
  /** Most important change anywhere below this folder */
  change: FileChange | null;
  changeCount: number;
}

type Row =
  | { kind: "dir"; node: DirNode; depth: number }
  | { kind: "file"; file: TreeFile; name: string; depth: number };

function buildTree(files: TreeFile[]): DirNode {
  const root: DirNode = { name: "", path: "", dirs: new Map(), files: [], change: null, changeCount: 0 };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    const chain = [root];
    for (let i = 0; i < parts.length - 1; i++) {
      let next = node.dirs.get(parts[i]);
      if (!next) {
        next = {
          name: parts[i], path: parts.slice(0, i + 1).join("/"),
          dirs: new Map(), files: [], change: null, changeCount: 0,
        };
        node.dirs.set(parts[i], next);
      }
      node = next;
      chain.push(node);
    }
    node.files.push(f);
    if (f.status) {
      for (const n of chain) {
        n.changeCount++;
        if (!n.change || PRIORITY.indexOf(f.status) < PRIORITY.indexOf(n.change)) n.change = f.status;
      }
    }
  }
  return root;
}

function flatten(node: DirNode, expanded: Set<string>, depth: number, out: Row[]) {
  const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const d of dirs) {
    out.push({ kind: "dir", node: d, depth });
    if (expanded.has(d.path)) flatten(d, expanded, depth + 1, out);
  }
  const files = [...node.files].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of files) {
    out.push({ kind: "file", file: f, name: f.path.slice(f.path.lastIndexOf("/") + 1), depth });
  }
}

export function FileExplorer({ onClose }: { onClose: () => void }) {
  const { activeRepo, status } = useAppStore();
  const [files, setFiles] = useState<TreeFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [onlyChanged, setOnlyChanged] = useState(false);

  const load = useCallback(() => {
    if (!activeRepo) return;
    setLoading(true);
    git.listRepoTree(activeRepo.path)
      .then(setFiles)
      .catch((e) => toast.error(`Failed to load file tree: ${e}`))
      .finally(() => setLoading(false));
  }, [activeRepo?.path]);

  // Reload whenever the app refreshes git status, so badges stay current
  useEffect(() => { load(); }, [load, status]);
  useEffect(() => { setExpanded(new Set()); }, [activeRepo?.path]);

  const tree = useMemo(
    () => buildTree(onlyChanged ? files.filter((f) => f.status) : files),
    [files, onlyChanged],
  );

  const rows = useMemo(() => {
    const out: Row[] = [];
    // "Only changed" shows every changed file without manual expanding
    const exp = onlyChanged ? new Set(collectDirs(tree)) : expanded;
    flatten(tree, exp, 0, out);
    return out;
  }, [tree, expanded, onlyChanged]);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });

  const openFile = (f: TreeFile) => {
    if (!activeRepo) return;
    // Deleted files no longer exist on disk; show the last committed version
    openFileInEditor(activeRepo.path, f.path, f.status === "deleted" ? { rev: "HEAD" } : {});
  };

  return (
    <div data-testid="file-explorer" className="flex flex-col h-full bg-card text-xs">
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border shrink-0">
        <span className="flex-1 truncate font-semibold uppercase tracking-wider text-[10px] text-muted-foreground">
          Explorer — {activeRepo?.name}
        </span>
        <button
          title="Show only changed files"
          onClick={() => setOnlyChanged((v) => !v)}
          className={cn(
            "px-1.5 py-0.5 rounded text-[10px] transition-colors",
            onlyChanged ? "bg-primary/30 text-primary" : "text-muted-foreground hover:bg-accent",
          )}
        >
          Changed
        </button>
        <button title="Refresh" onClick={load} className="p-1 rounded text-muted-foreground hover:bg-accent">
          <RefreshCw size={12} className={cn(loading && "animate-spin")} />
        </button>
        <button title="Close explorer (Ctrl+Shift+E)" onClick={onClose} className="p-1 rounded text-muted-foreground hover:bg-accent">
          <X size={12} />
        </button>
      </div>

      {rows.length === 0 && !loading ? (
        <p className="px-3 py-2 text-muted-foreground">{onlyChanged ? "No changes" : "No files"}</p>
      ) : (
        <Virtuoso
          style={{ flex: 1 }}
          data={rows}
          computeItemKey={(_, r) => (r.kind === "dir" ? `d:${r.node.path}` : `f:${r.file.path}`)}
          itemContent={(_, row) => {
            const pad = { paddingLeft: 8 + row.depth * 12 };
            if (row.kind === "dir") {
              const open = onlyChanged || expanded.has(row.node.path);
              const style = row.node.change ? CHANGE_STYLE[row.node.change] : null;
              return (
                <div
                  style={pad}
                  title={style ? `${row.node.path} — ${row.node.changeCount} changed` : row.node.path}
                  onClick={() => !onlyChanged && toggle(row.node.path)}
                  className="flex items-center gap-1 pr-3 h-[22px] cursor-pointer hover:bg-accent select-none"
                >
                  {open ? <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
                        : <ChevronRight size={12} className="shrink-0 text-muted-foreground" />}
                  {open ? <FolderOpen size={13} className="shrink-0 text-sky-400/80" />
                        : <Folder size={13} className="shrink-0 text-sky-400/80" />}
                  <span className={cn("flex-1 truncate", style ? style.text : "text-foreground")}>{row.node.name}</span>
                  {style && <span className={cn("w-1.5 h-1.5 rounded-full shrink-0 bg-current", style.text)} />}
                </div>
              );
            }
            const style = row.file.status ? CHANGE_STYLE[row.file.status] : null;
            return (
              <div
                style={{ paddingLeft: pad.paddingLeft + 13 }}
                title={style ? `${row.file.path} — ${style.label}` : row.file.path}
                onClick={() => openFile(row.file)}
                className="flex items-center gap-1 pr-3 h-[22px] cursor-pointer hover:bg-accent select-none"
              >
                <File size={12} className="shrink-0 text-muted-foreground" />
                <span className={cn(
                  "flex-1 truncate",
                  style ? style.text : "text-foreground/90",
                  row.file.status === "deleted" && "line-through opacity-80",
                )}>
                  {row.name}
                </span>
                {style && <span className={cn("shrink-0 font-mono font-semibold text-[10px]", style.text)}>{style.letter}</span>}
              </div>
            );
          }}
        />
      )}
    </div>
  );
}

function collectDirs(node: DirNode, out: string[] = []): string[] {
  for (const d of node.dirs.values()) {
    out.push(d.path);
    collectDirs(d, out);
  }
  return out;
}
