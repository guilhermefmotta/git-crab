import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle, CheckCircle,
  FileWarning, GitMerge,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { git } from "@/lib/tauri";
import type { ConflictContent, RepoStatus } from "@/lib/mergeTypes";
import { ThreePaneEditor } from "./ThreePaneEditor";
import { emitRepoChanged } from "@/lib/repoEvents";

// ── File editor: loads content and delegates to ThreePaneEditor ───────────────

function FileEditor({
  repoPath, filePath, onStaged, onSkip,
}: {
  repoPath: string;
  filePath: string;
  onStaged: () => void;
  onSkip: () => void;
}) {
  const [content, setContent] = useState<ConflictContent | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setContent(null);
    git.getConflictContent(repoPath, filePath)
      .then(setContent)
      .catch(e => toast.error(String(e)))
      .finally(() => setLoading(false));
  }, [repoPath, filePath]);

  if (loading) return (
    <div className="flex items-center justify-center h-full gap-2">
      <Loader2 size={14} className="animate-spin text-muted-foreground" />
      <span className="text-xs text-muted-foreground">Loading…</span>
    </div>
  );

  if (content?.isBinary) return (
    <div className="flex flex-col items-center justify-center h-full gap-3">
      <FileWarning size={24} className="text-yellow-400" />
      <p className="text-xs text-muted-foreground">Binary file — resolve manually in your editor</p>
      <button onClick={onSkip}
        className="px-3 py-1.5 text-xs bg-secondary text-secondary-foreground rounded hover:bg-secondary/80 transition-colors">
        Skip
      </button>
    </div>
  );

  if (!content) return null;

  return (
    <ThreePaneEditor
      repoPath={repoPath}
      filePath={filePath}
      content={content}
      onStaged={onStaged}
      onSkip={onSkip}
    />
  );
}

// ── File list sidebar ─────────────────────────────────────────────────────────

function FileList({
  files, current, resolved, onSelect,
}: {
  files: string[];
  current: string | null;
  resolved: Set<string>;
  onSelect: (f: string) => void;
}) {
  return (
    <div data-testid="file-list" className="w-56 shrink-0 border-r border-border bg-card/50 flex flex-col overflow-hidden">
      <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b border-border">
        Conflicted Files ({files.length})
      </div>
      <div className="flex-1 overflow-y-auto">
        {files.map(f => {
          const isResolved = resolved.has(f);
          const isCurrent  = f === current;
          return (
            <button
              key={f}
              onClick={() => onSelect(f)}
              data-testid={`conflict-file-${f.split("/").pop()}`}
              className={cn(
                "w-full text-left px-3 py-2 text-[11px] flex items-center gap-2 border-b border-border/30 hover:bg-accent/20 transition-colors",
                isCurrent && "bg-accent/30",
              )}
            >
              {isResolved
                ? <CheckCircle size={12} className="text-green-400 shrink-0" />
                : <AlertTriangle size={12} className="text-yellow-400 shrink-0" />}
              <span className={cn(
                "truncate font-mono",
                isResolved ? "text-muted-foreground line-through" : isCurrent ? "text-foreground" : "text-foreground/70",
              )}>
                {f.split("/").pop()}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Operation banner ──────────────────────────────────────────────────────────

const OP_LABELS: Record<string, string> = {
  Merging:       "Merging",
  Rebasing:      "Rebasing",
  CherryPicking: "Cherry-picking",
  Reverting:     "Reverting",
  Conflicted:    "Conflicts",
};

function Banner({
  status, resolvedCount, onAbort, onComplete, completing,
}: {
  status: RepoStatus;
  resolvedCount: number;
  onAbort: () => void;
  onComplete: () => void;
  completing: boolean;
}) {
  const op       = OP_LABELS[status.operation] ?? status.operation;
  const total    = status.conflictedFiles.length;
  const allDone  = resolvedCount === total;
  const isRebase = status.operation === "Rebasing";
  const needsCommit = status.operation === "Merging";

  const completeLabel = isRebase ? "Continue Rebase" : needsCommit ? "Commit Merge" : "Done";

  return (
    <div data-testid="merge-banner" className="flex items-center gap-3 px-4 py-2.5 border-b border-yellow-500/20 bg-yellow-950/12 shrink-0">
      <GitMerge size={14} className="text-yellow-400 shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="text-sm font-medium text-yellow-300">{op}</span>
        {status.operationLabel && (
          <span className="text-xs text-yellow-400/55 ml-2 font-mono">{status.operationLabel}</span>
        )}
        {status.headBranch && (
          <span className="text-xs text-muted-foreground ml-2">
            into <span className="font-mono text-foreground/70">{status.headBranch}</span>
          </span>
        )}
        <span className="text-xs text-muted-foreground ml-3">
          {resolvedCount}/{total} files staged
        </span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button onClick={onAbort} data-testid="abort-btn"
          className="px-3 py-1 text-xs border border-border/40 rounded hover:bg-accent/20 text-muted-foreground hover:text-foreground transition-colors">
          {needsCommit ? "Abort Merge" : isRebase ? "Abort Rebase" : "Abort"}
        </button>
        <button onClick={onComplete} disabled={!allDone || completing} data-testid="complete-btn"
          className="flex items-center gap-1.5 px-3 py-1 text-xs bg-green-700 text-white rounded hover:bg-green-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
          {completing && <Loader2 size={10} className="animate-spin" />}
          {completeLabel}
        </button>
      </div>
    </div>
  );
}

// ── Root MergeWorkspace ───────────────────────────────────────────────────────

interface Props {
  repoPath: string;
  status: RepoStatus;
  onDone: () => void;
}

export function MergeWorkspace({ repoPath, status, onDone }: Props) {
  const [current, setCurrent]   = useState<string | null>(status.conflictedFiles[0] ?? null);
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const [completing, setCompleting] = useState(false);

  useEffect(() => {
    setResolved(new Set());
    setCurrent(status.conflictedFiles[0] ?? null);
  }, [status.conflictedFiles.join(",")]);

  // "Done" on a file: mark it resolved and jump to the next unresolved one
  // (null once every file is done, which shows the commit prompt)
  const handleStaged = useCallback(() => {
    if (!current) return;
    const next = new Set(resolved).add(current);
    setResolved(next);
    emitRepoChanged(repoPath);
    const after = status.conflictedFiles.slice(status.conflictedFiles.indexOf(current) + 1);
    const before = status.conflictedFiles.slice(0, status.conflictedFiles.indexOf(current));
    setCurrent([...after, ...before].find(f => !next.has(f)) ?? null);
  }, [current, resolved, status.conflictedFiles, repoPath]);

  const handleAbort = async () => {
    try {
      await git.abortOperation(repoPath);
      toast.success("Operation aborted — files restored");
      emitRepoChanged(repoPath);
      onDone();
    } catch (e) {
      toast.error(String(e));
    }
  };

  const handleComplete = async () => {
    setCompleting(true);
    try {
      if (status.operation === "Merging") {
        await git.completeMergeCommit(repoPath);
        toast.success("Merge committed");
      } else if (status.operation === "Rebasing") {
        const newStatus = await git.continueOperation(repoPath);
        if (newStatus.conflictedFiles.length > 0) {
          toast.info(`Next rebase step: ${newStatus.conflictedFiles.length} conflict(s)`);
          setResolved(new Set());
          setCurrent(newStatus.conflictedFiles[0]);
          return;
        }
        toast.success("Rebase completed");
      } else {
        toast.success("Conflicts resolved");
      }
      emitRepoChanged(repoPath);
      onDone();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setCompleting(false);
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <Banner
        status={status}
        resolvedCount={resolved.size}
        onAbort={handleAbort}
        onComplete={handleComplete}
        completing={completing}
      />
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <FileList
          files={status.conflictedFiles}
          current={current}
          resolved={resolved}
          onSelect={setCurrent}
        />
        <div className="flex-1 min-w-0 overflow-hidden">
          {current ? (
            <FileEditor
              key={current}
              repoPath={repoPath}
              filePath={current}
              onStaged={handleStaged}
              onSkip={() => {
                const remaining = status.conflictedFiles.filter(f => f !== current);
                setCurrent(remaining[0] ?? null);
              }}
            />
          ) : status.conflictedFiles.length > 0 && resolved.size >= status.conflictedFiles.length ? (
            <div className="flex flex-col items-center justify-center h-full gap-3" data-testid="all-files-resolved">
              <CheckCircle size={28} className="text-green-400" />
              <p className="text-sm text-foreground">All {status.conflictedFiles.length} files resolved</p>
              <button
                onClick={handleComplete}
                disabled={completing}
                className="flex items-center gap-1.5 px-4 py-2 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors disabled:opacity-40"
              >
                {completing && <Loader2 size={12} className="animate-spin" />}
                {status.operation === "Rebasing" ? "Continue rebase" : status.operation === "Merging" ? "Commit merge" : "Finish"}
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-xs text-muted-foreground">Select a file to view conflicts</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
