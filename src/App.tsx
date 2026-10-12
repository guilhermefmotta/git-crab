import { useCallback, useEffect, useRef, useState } from "react";
import { applySettings } from "@/hooks/useApplySettings";
import { Toaster } from "sonner";
import { useAppStore } from "@/store/appStore";
import { TopToolbar } from "@/components/layout/TopToolbar";
import { Sidebar } from "@/components/layout/Sidebar";
import { CommitGraph } from "@/components/graph/CommitGraph";
import { DetailPanel } from "@/components/layout/DetailPanel";
import { WelcomeScreen } from "@/components/dialogs/WelcomeScreen";
import { SettingsDialog } from "@/components/dialogs/SettingsDialog";
import { QuickOpenDialog } from "@/components/dialogs/QuickOpenDialog";
import { SearchDialog } from "@/components/dialogs/SearchDialog";
import { MergeWorkspace } from "@/components/merge/MergeWorkspace";
import { useStatus } from "@/hooks/useStatus";
import { useRepo } from "@/hooks/useRepo";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { git } from "@/lib/tauri";
import type { RepoStatus } from "@/lib/mergeTypes";
import { AlertTriangle } from "lucide-react";

// Conflict banner (conflicts present — opens inline resolver)
function ConflictBanner({
  status, onResolve,
}: {
  status: RepoStatus;
  onResolve: () => void;
}) {
  return (
    <div data-testid="conflict-banner" className="flex items-center gap-3 px-4 py-2 border-b border-yellow-500/20 bg-yellow-950/10 shrink-0">
      <AlertTriangle size={13} className="text-yellow-400 shrink-0" />
      <span className="text-xs text-yellow-300 flex-1">
        {status.conflictedFiles.length} file{status.conflictedFiles.length !== 1 ? "s have" : " has"} conflicts
        {status.operationLabel && (
          <span className="text-yellow-400/50 font-mono ml-2">{status.operationLabel}</span>
        )}
      </span>
      <button onClick={onResolve} data-testid="resolve-conflicts-btn"
        className="px-3 py-1 text-xs bg-yellow-700 text-white rounded hover:bg-yellow-600 transition-colors">
        Resolve Conflicts
      </button>
    </div>
  );
}

// ── Resizable divider ────────────────────────────────────────────────────────

function ResizeDivider({ onDelta, testId }: { onDelta: (dx: number) => void; testId?: string }) {
  const dragging = useRef(false);
  const lastX    = useRef(0);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    lastX.current    = e.clientX;

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      onDelta(ev.clientX - lastX.current);
      lastX.current = ev.clientX;
    };
    const onUp = () => {
      dragging.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup",   onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
  };

  return (
    <div
      onMouseDown={onMouseDown}
      data-testid={testId}
      className="w-1 shrink-0 cursor-col-resize bg-border hover:bg-primary/60 active:bg-primary transition-colors z-10"
    />
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const { activeRepo, settings, setSelectedCommitHash, status: fileStatus } = useAppStore();
  const { refresh: refreshFileStatus } = useStatus();
  const { openRepoPaths } = useRepo();
  const [settingsOpen, setSettingsOpen]   = useState(false);
  const [quickOpen, setQuickOpen]         = useState(false);
  const [searchOpen, setSearchOpen]       = useState(false);
  const [mergeStatus, setMergeStatus]     = useState<RepoStatus | null>(null);
  const [showResolver, setShowResolver]   = useState(false);
  const [sidebarWidth, setSidebarWidth]   = useState(240);
  const [detailWidth, setDetailWidth]     = useState(320);

  useEffect(() => {
    applySettings(settings.theme, settings.fontSize);
  }, [settings.theme, settings.fontSize]);

  const refreshMergeStatus = useCallback(async () => {
    if (!activeRepo) { setMergeStatus(null); return; }
    try {
      const s = await git.getRepoStatus(activeRepo.path);
      const active = s.operation !== "Clean" || s.conflictedFiles.length > 0;
      setMergeStatus(active ? s : null);
    } catch {
      setMergeStatus(null);
    }
  }, [activeRepo]);

  // Close resolver when repo changes
  useEffect(() => { setShowResolver(false); refreshMergeStatus(); }, [activeRepo?.path]);
  useEffect(() => { if (activeRepo) refreshMergeStatus(); }, [fileStatus]);

  // Dropping folders onto the window opens every one of them as a tab
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop") openRepoPaths(event.payload.paths);
      })
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, [openRepoPaths]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === ",") { e.preventDefault(); setSettingsOpen(true); return; }
      if (mod && e.shiftKey && e.key.toLowerCase() === "f") { e.preventDefault(); setSearchOpen(true); return; }
      if (mod && e.key.toLowerCase() === "p") { e.preventDefault(); setQuickOpen(true); return; }
      if (mod && e.key === "f") {
        e.preventDefault();
        (document.getElementById("commit-search") as HTMLInputElement | null)?.focus();
        return;
      }
      if (e.key === "Escape") {
        const active = document.activeElement as HTMLElement | null;
        if (active && active.tagName !== "BODY") { active.blur(); return; }
        setSelectedCommitHash(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setSelectedCommitHash]);

  const toastOpts = {
    style: {
      background: settings.theme === "dark" ? "hsl(222 47% 13%)" : "hsl(0 0% 97%)",
      border: `1px solid hsl(${settings.theme === "dark" ? "217 32% 17%" : "214 32% 86%"})`,
      color: settings.theme === "dark" ? "hsl(210 40% 98%)" : "hsl(222 47% 11%)",
      fontSize: "12px",
    },
  };

  // Derive conflict state from fileStatus (same source as WorkingTree) — always accurate
  const hasConflicts = fileStatus.some(f => f.status === "conflicted");

  const handleResolverDone = async () => {
    setShowResolver(false);
    setMergeStatus(null); // clear immediately to avoid stale banner flash
    await Promise.all([refreshMergeStatus(), refreshFileStatus()]);
  };

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-background text-foreground">
      <TopToolbar onOpenSettings={() => setSettingsOpen(true)} />

      {/* Status banners — always visible, never hide the commit graph */}
      {hasConflicts && activeRepo && mergeStatus && (
        <ConflictBanner status={mergeStatus} onResolve={() => setShowResolver(true)} />
      )}

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {!activeRepo ? (
          <WelcomeScreen />
        ) : (
          <>
            <div data-testid="sidebar-wrapper" style={{ width: sidebarWidth, flexShrink: 0 }} className="min-w-0 overflow-hidden">
              <Sidebar onOperationComplete={refreshMergeStatus} />
            </div>
            <ResizeDivider testId="resize-divider-sidebar" onDelta={(dx) => setSidebarWidth(w => Math.max(160, Math.min(520, w + dx)))} />
            <CommitGraph />
            <ResizeDivider testId="resize-divider-detail" onDelta={(dx) => setDetailWidth(w => Math.max(200, Math.min(640, w - dx)))} />
            <div data-testid="detail-wrapper" style={{ width: detailWidth, flexShrink: 0 }} className="min-w-0 overflow-hidden">
              <DetailPanel />
            </div>
          </>
        )}
      </div>

      {/* Inline conflict resolver — full-screen overlay */}
      {showResolver && activeRepo && mergeStatus && (
        <div className="absolute inset-0 z-50 bg-background flex flex-col overflow-hidden">
          <MergeWorkspace
            repoPath={activeRepo.path}
            status={mergeStatus}
            onDone={handleResolverDone}
          />
        </div>
      )}

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <QuickOpenDialog open={quickOpen && !!activeRepo} onClose={() => setQuickOpen(false)} />
      {/* Mounted only while open: its branch/status/commit hooks load data on mount */}
      {searchOpen && activeRepo && <SearchDialog open onClose={() => setSearchOpen(false)} />}
      <Toaster position="bottom-right" theme={settings.theme} toastOptions={toastOpts} />
    </div>
  );
}
