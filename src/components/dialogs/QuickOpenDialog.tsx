import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { git } from "@/lib/tauri";
import { useAppStore } from "@/store/appStore";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { EditorMeta } from "@/EditorWindow";

const MAX_RESULTS = 100;

/**
 * Subsequence fuzzy match. Returns null when `query` doesn't match `path`,
 * otherwise a score (higher is better) favouring consecutive characters and
 * matches inside the file name over the directory part.
 */
function fuzzyScore(path: string, query: string): number | null {
  const p = path.toLowerCase();
  const nameStart = p.lastIndexOf("/") + 1;
  let score = 0;
  let pi = 0;
  let prev = -2;
  for (const ch of query) {
    const idx = p.indexOf(ch, pi);
    if (idx < 0) return null;
    score += idx === prev + 1 ? 5 : 1;
    if (idx >= nameStart) score += 2;
    if (idx === nameStart || p[idx - 1] === "/" || p[idx - 1] === "_" || p[idx - 1] === "-" || p[idx - 1] === ".") score += 3;
    prev = idx;
    pi = idx + 1;
  }
  return score - path.length * 0.01;
}

export function openFileInEditor(
  repoPath: string,
  filePath: string,
  extra: Omit<EditorMeta, "repoPath" | "filePath" | "nonce"> = {},
) {
  const id = extra.rev ? `${extra.rev}__${filePath}` : filePath;
  const key = id.replace(/[^a-zA-Z0-9_\-]/g, "_");
  const meta: EditorMeta = { repoPath, filePath, ...extra, nonce: Date.now() };
  localStorage.setItem(`git_rust_editor_${key}`, JSON.stringify(meta));
  const title = extra.rev ? `${filePath} @ ${extra.rev}` : filePath;
  git.openEditorWindow(key, title).catch((e) => toast.error(`Failed to open editor: ${e}`));
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function QuickOpenDialog({ open, onClose }: Props) {
  const { activeRepo } = useAppStore();
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Re-list on every open so new/deleted files show up
  useEffect(() => {
    if (!open || !activeRepo) return;
    setQuery("");
    setCursor(0);
    setLoading(true);
    git.listRepoFiles(activeRepo.path)
      .then(setFiles)
      .catch((e) => toast.error(`Failed to list files: ${e}`))
      .finally(() => setLoading(false));
  }, [open, activeRepo?.path]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/\s+/g, "");
    if (!q) return files.slice(0, MAX_RESULTS);
    const scored: { path: string; score: number }[] = [];
    for (const path of files) {
      const score = fuzzyScore(path, q);
      if (score !== null) scored.push({ path, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS).map((s) => s.path);
  }, [files, query]);

  useEffect(() => { setCursor(0); }, [query]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const choose = (path: string | undefined) => {
    if (!path || !activeRepo) return;
    openFileInEditor(activeRepo.path, path);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-xl p-0 gap-0 top-[20%] translate-y-0">
        <DialogTitle className="sr-only">Go to file</DialogTitle>
        <div className="flex items-center gap-2 pl-3 pr-10 py-2 border-b border-border">
          <FileText size={13} className="text-muted-foreground shrink-0" />
          <input
            autoFocus
            data-testid="quick-open-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, results.length - 1)); }
              if (e.key === "ArrowUp")   { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
              if (e.key === "Enter")     { e.preventDefault(); choose(results[cursor]); }
            }}
            placeholder={activeRepo ? `Search files in ${activeRepo.name}…` : "Open a repository first"}
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
          />
          {loading && <Loader2 size={13} className="animate-spin text-muted-foreground" />}
        </div>
        <div ref={listRef} className="max-h-96 overflow-y-auto py-1">
          {!loading && results.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">No matching files</p>
          )}
          {results.map((path, i) => {
            const slash = path.lastIndexOf("/");
            return (
              <div
                key={path}
                data-index={i}
                onMouseMove={() => setCursor(i)}
                onClick={() => choose(path)}
                className={cn(
                  "flex items-baseline gap-2 px-3 py-1 cursor-pointer text-xs",
                  i === cursor ? "bg-primary/20" : "hover:bg-accent",
                )}
              >
                <span className="text-foreground shrink-0">{path.slice(slash + 1)}</span>
                <span className="text-muted-foreground truncate">{slash > 0 ? path.slice(0, slash) : ""}</span>
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
