import { useEffect } from "react";
import { formatDistanceToNow, format } from "date-fns";
import { GitCommit, User, Clock } from "lucide-react";
import { git } from "@/lib/tauri";
import { useAppStore } from "@/store/appStore";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { CommitInfo } from "@/lib/types";

function MetaRow({ icon: Icon, value }: { icon: React.ElementType; value: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Icon size={11} className="shrink-0" />
      <span className="truncate">{value}</span>
    </div>
  );
}

export function CommitDetail({ commit }: { commit: CommitInfo }) {
  const { activeRepo, diff, setDiff, loadingDiff, setLoadingDiff, selectedFilePath, setSelectedFilePath } =
    useAppStore();

  useEffect(() => {
    const loadDiff = async () => {
      if (!activeRepo) return;
      setLoadingDiff(true);
      setSelectedFilePath(null);
      try {
        const result = await git.getDiff(activeRepo.path, {
          commitHash: commit.hash,
        });
        setDiff(result);
      } catch {
        setDiff([]);
      } finally {
        setLoadingDiff(false);
      }
    };

    loadDiff();
  }, [commit.hash, activeRepo]);

  const date = new Date(commit.timestamp * 1000);

  return (
    <div className="flex flex-col h-full">
      {/* Commit metadata */}
      <div className="p-3 border-b border-border space-y-2 shrink-0">
        <div className="flex items-start gap-2">
          <GitCommit size={14} className="shrink-0 text-primary mt-0.5" />
          <p className="text-xs font-medium text-foreground leading-snug">
            {commit.message}
          </p>
        </div>
        <MetaRow icon={User} value={`${commit.author_name} <${commit.author_email}>`} />
        <MetaRow
          icon={Clock}
          value={`${format(date, "MMM d, yyyy HH:mm")} (${formatDistanceToNow(date, { addSuffix: true })})`}
        />
        <div className="flex items-center gap-2">
          <code className="text-[10px] bg-secondary px-1.5 py-0.5 rounded font-mono text-muted-foreground">
            {commit.short_hash}
          </code>
          {commit.refs.map((ref) => (
            <span
              key={ref.name}
              className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                ref.is_head
                  ? "bg-primary/30 text-primary"
                  : ref.ref_type === "tag"
                  ? "bg-yellow-500/20 text-yellow-400"
                  : "bg-green-500/20 text-green-400"
              }`}
            >
              {ref.name}
            </span>
          ))}
        </div>
      </div>

      {/* Changed files */}
      {loadingDiff && (
        <p className="px-3 py-2 text-xs text-muted-foreground">Loading files…</p>
      )}
      {!loadingDiff && diff.length > 0 && (
        <div className="flex flex-col flex-1 min-h-0">
          <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Changed files ({diff.length})
          </p>
          <div className="flex-1 overflow-y-auto">
            {diff.map((f) => (
              <ContextMenu key={f.path}>
                <ContextMenuTrigger asChild>
                  <div
                    data-testid={`commit-file-${f.path.replace(/\//g, "-")}`}
                    title="Open diff"
                    onClick={() => {
                      if (!activeRepo) return;
                      setSelectedFilePath(f.path);
                      const key = `commit_${commit.hash}_${f.path.replace(/[^a-zA-Z0-9_\-]/g, "_")}`;
                      localStorage.setItem(`git_rust_filediff_${key}`, JSON.stringify({
                        repoPath: activeRepo.path,
                        filePath: f.path,
                        staged: false,
                        commitHash: commit.hash,
                        shortHash: commit.short_hash,
                      }));
                      git.openFileDiffWindow(key, `${commit.short_hash} — ${f.path}`).catch(() => {});
                    }}
                    className={`px-3 py-1 text-xs cursor-pointer transition-colors ${
                      selectedFilePath === f.path ? "bg-primary/15" : "hover:bg-accent"
                    }`}
                  >
                    {f.path}
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem data-testid="ctx-file-history" onClick={() => {
                    if (!activeRepo) return;
                    const key = f.path.replace(/[^a-zA-Z0-9_\-]/g, "_");
                    localStorage.setItem(`git_rust_filehistory_${key}`, JSON.stringify({
                      repoPath: activeRepo.path,
                      filePath: f.path,
                    }));
                    git.openFileHistoryWindow(key, `History — ${f.path}`).catch(() => {});
                  }}>
                    File History
                  </ContextMenuItem>
                  <ContextMenuItem data-testid="ctx-view-diff" onClick={() => {
                    if (!activeRepo) return;
                    const key = `commit_${commit.hash}_${f.path.replace(/[^a-zA-Z0-9_\-]/g, "_")}`;
                    localStorage.setItem(`git_rust_filediff_${key}`, JSON.stringify({
                      repoPath: activeRepo.path,
                      filePath: f.path,
                      staged: false,
                      commitHash: commit.hash,
                      shortHash: commit.short_hash,
                    }));
                    git.openFileDiffWindow(key, `${commit.short_hash} — ${f.path}`).catch(() => {});
                  }}>
                    View diff
                  </ContextMenuItem>
                  <ContextMenuItem data-testid="ctx-file-blame" onClick={() => {
                    if (!activeRepo) return;
                    const key = `blame_${commit.hash}_${f.path.replace(/[^a-zA-Z0-9_\-]/g, "_")}`;
                    localStorage.setItem(`git_rust_blame_${key}`, JSON.stringify({
                      repoPath: activeRepo.path,
                      filePath: f.path,
                      commitHash: commit.hash,
                    }));
                    git.openBlameWindow(key, `Blame — ${f.path}`).catch(() => {});
                  }}>
                    Blame
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
