import { useEffect, useMemo, useRef, useState } from "react";
import { CaseSensitive, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { git } from "@/lib/tauri";
import { useAppStore } from "@/store/appStore";
import type { SearchMatch, SearchResult } from "@/lib/types";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { openFileInEditor } from "./QuickOpenDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { useBranches } from "@/hooks/useBranches";
import { useStatus } from "@/hooks/useStatus";
import { useCommits } from "@/hooks/useCommits";

const WORKSPACE = "__workspace__";

interface Confirm {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  extraAction?: { label: string; action: () => void };
}

const isCheckoutBlocked = (msg: string) =>
  /conflict.{0,10}prevent.{0,10}checkout/i.test(msg)
  || msg.includes("overwritten by checkout")
  || msg.includes("needs merge");
const DEBOUNCE_MS = 200;

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SearchDialog({ open, onClose }: Props) {
  const { activeRepo, branches, activeBranchFilter } = useAppStore();
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [scope, setScope] = useState(WORKSPACE);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const { refresh: refreshBranches, refreshHead } = useBranches();
  const { refresh: refreshStatus } = useStatus();
  const { loadCommits } = useCommits();

  // Default scope: the branch filtered in the graph, else the working tree
  useEffect(() => {
    if (!open) return;
    setScope(activeBranchFilter ?? WORKSPACE);
    setTimeout(() => inputRef.current?.select(), 0);
  }, [open]);

  useEffect(() => {
    if (!open || !activeRepo) return;
    const q = query;
    if (!q.trim()) { setResult(null); setLoading(false); return; }
    const id = ++requestRef.current;
    setLoading(true);
    const timer = setTimeout(() => {
      const started = performance.now();
      git.searchText(activeRepo.path, q, scope === WORKSPACE ? undefined : scope, caseSensitive)
        .then((r) => {
          // Drop responses for queries the user has already typed past
          if (id !== requestRef.current) return;
          setResult(r);
          setCursor(0);
          setElapsed(Math.round(performance.now() - started));
        })
        .catch((e) => { if (id === requestRef.current) toast.error(`Search failed: ${e}`); })
        .finally(() => { if (id === requestRef.current) setLoading(false); });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, activeRepo?.path, query, scope, caseSensitive]);

  const matches = result?.matches ?? [];
  const fileCount = useMemo(() => new Set(matches.map((m) => m.path)).size, [matches]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const openMatch = (m: SearchMatch, rev?: string) => {
    if (!activeRepo) return;
    openFileInEditor(activeRepo.path, m.path, { rev, line: m.line, query, caseSensitive });
  };

  const afterCheckout = async (localName: string, m: SearchMatch) => {
    await Promise.all([refreshBranches(), refreshHead(), refreshStatus(), loadCommits(0)]);
    toast.success(`Switched to ${localName}`);
    // HEAD is now this branch, so results from here on open editable
    setScope(localName);
    openMatch(m);
  };

  // Check out `localName` (creating it from `createFrom` when it only exists
  // on the remote), then open the match editable. Local edits that block the
  // checkout get a second prompt offering Smart Checkout (stash/switch/restore).
  const checkoutAndEdit = async (localName: string, createFrom: string | undefined, m: SearchMatch) => {
    if (!activeRepo) return;
    const repo = activeRepo.path;
    try {
      if (createFrom) await git.createBranch(repo, localName, createFrom, true);
      else await git.checkoutBranch(repo, localName);
      await afterCheckout(localName, m);
    } catch (e) {
      const msg = String(e);
      if (!isCheckoutBlocked(msg)) { toast.error(msg); refreshBranches(); return; }
      // createBranch already created the branch before its checkout failed
      refreshBranches();
      setConfirm({
        title: "Local changes block checkout",
        description: `Your uncommitted changes conflict with "${localName}". Smart Checkout stashes them, switches branch, then restores them (conflicts open in the resolver).`,
        confirmLabel: "Smart Checkout",
        onConfirm: async () => {
          setConfirm(null);
          try {
            const outcome = await git.smartCheckout(repo, localName);
            if (outcome.conflictedFiles.length > 0) git.openMergeWindow(repo).catch(() => {});
            await afterCheckout(localName, m);
          } catch (err) {
            toast.error(String(err));
          }
        },
        extraAction: { label: "Open read-only", action: () => { setConfirm(null); openMatch(m, scope); } },
      });
    }
  };

  const choose = (m: SearchMatch | undefined) => {
    if (!m || !activeRepo) return;
    if (scope === WORKSPACE) return openMatch(m);

    const target = branches.find((b) => b.name === scope);
    if (!target) return openMatch(m, scope);
    if (target.is_head && !target.is_remote) return openMatch(m);

    // Editing needs the branch checked out on disk; ask before switching
    const localName = target.is_remote ? target.name.slice(target.name.indexOf("/") + 1) : target.name;
    const local = branches.find((b) => !b.is_remote && b.name === localName);
    const readOnly = { label: "Open read-only", action: () => { setConfirm(null); openMatch(m, scope); } };

    if (target.is_remote && local?.is_head) {
      setConfirm({
        title: "Edit your local copy?",
        description: `"${localName}" (your checked-out branch) is the local copy of "${target.name}". Editing opens the file on disk, which may differ from the remote until you pull.`,
        confirmLabel: "Edit local",
        onConfirm: () => { setConfirm(null); openMatch(m); },
        extraAction: readOnly,
      });
      return;
    }

    const createFrom = target.is_remote && !local ? target.last_commit_hash ?? undefined : undefined;
    setConfirm({
      title: target.is_remote && !local ? "Branch only exists on the remote" : "Branch not checked out",
      description: target.is_remote && !local
        ? `"${target.name}" isn't available locally. Create local branch "${localName}" from it and check it out so you can edit "${m.path}"?`
        : `To edit "${m.path}" you need "${localName}" checked out (current: ${activeRepo.head_branch ?? "detached"}). Check it out now?`,
      confirmLabel: "Checkout & edit",
      onConfirm: () => { setConfirm(null); checkoutAndEdit(localName, createFrom, m); },
      extraAction: readOnly,
    });
  };

  const localBranches  = branches.filter((b) => !b.is_remote);
  const remoteBranches = branches.filter((b) => b.is_remote);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl p-0 gap-0 top-[10%] translate-y-0">
        <DialogTitle className="sr-only">Search in files</DialogTitle>
        <div className="flex items-center gap-2 pl-3 pr-10 py-2 border-b border-border">
          <Search size={13} className="text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            autoFocus
            data-testid="search-text-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, matches.length - 1)); }
              if (e.key === "ArrowUp")   { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
              if (e.key === "Enter")     { e.preventDefault(); choose(matches[cursor]); }
            }}
            placeholder="Search text in files…"
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
          />
          {loading && <Loader2 size={13} className="animate-spin text-muted-foreground" />}
          <button
            title="Match case"
            data-testid="search-case"
            onClick={() => setCaseSensitive((v) => !v)}
            className={cn(
              "p-1 rounded transition-colors",
              caseSensitive ? "bg-primary/30 text-primary" : "text-muted-foreground hover:bg-accent",
            )}
          >
            <CaseSensitive size={14} />
          </button>
          <select
            data-testid="search-scope"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            className="bg-secondary text-xs text-foreground rounded px-1.5 py-1 outline-none max-w-48"
          >
            <option value={WORKSPACE}>Workspace (disk)</option>
            {localBranches.length > 0 && (
              <optgroup label="Local branches">
                {localBranches.map((b) => (
                  <option key={b.name} value={b.name}>{b.name}{b.is_head ? " (HEAD)" : ""}</option>
                ))}
              </optgroup>
            )}
            {remoteBranches.length > 0 && (
              <optgroup label="Remote branches">
                {remoteBranches.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
              </optgroup>
            )}
          </select>
        </div>

        <div ref={listRef} className="max-h-[60vh] overflow-y-auto py-1 font-mono text-[11px]">
          {result && matches.length === 0 && !loading && (
            <p className="px-3 py-2 text-xs text-muted-foreground font-sans">No results</p>
          )}
          {matches.map((m, i) => {
            const newFile = i === 0 || matches[i - 1].path !== m.path;
            return (
              <div key={`${m.path}:${m.line}`}>
                {newFile && (
                  <div className="px-3 pt-2 pb-0.5 text-xs font-sans font-semibold text-foreground truncate">
                    {m.path}
                  </div>
                )}
                <div
                  data-index={i}
                  onMouseMove={() => setCursor(i)}
                  onClick={() => choose(m)}
                  className={cn(
                    "flex gap-3 pl-5 pr-3 py-0.5 cursor-pointer",
                    i === cursor ? "bg-primary/20" : "hover:bg-accent",
                  )}
                >
                  <span className="w-10 shrink-0 text-right text-muted-foreground">{m.line}</span>
                  <span className="truncate text-foreground/80 whitespace-pre">
                    {m.text.slice(0, m.start)}
                    <mark className="bg-orange-500/40 text-orange-100 rounded-sm px-px outline outline-1 outline-orange-400/70">
                      {m.text.slice(m.start, m.end)}
                    </mark>
                    {m.text.slice(m.end)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {result && (
          <div className="px-3 py-1.5 border-t border-border text-[10px] text-muted-foreground flex gap-3">
            <span>{matches.length}{result.truncated ? "+" : ""} results in {fileCount} files</span>
            <span>{result.files_searched} files searched</span>
            {elapsed !== null && <span>{elapsed} ms</span>}
            <span className="ml-auto">
              {scope === WORKSPACE
                ? "Workspace — opens editable"
                : branches.find((b) => b.name === scope)?.is_head
                  ? `${scope} (checked out) — opens editable`
                  : `${scope} — asks to checkout before editing`}
            </span>
          </div>
        )}
      </DialogContent>
      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title ?? ""}
        description={confirm?.description ?? ""}
        confirmLabel={confirm?.confirmLabel}
        onConfirm={() => confirm?.onConfirm()}
        onCancel={() => setConfirm(null)}
        extraAction={confirm?.extraAction}
      />
    </Dialog>
  );
}
