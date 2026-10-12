import { useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { git } from "@/lib/tauri";
import { useAppStore } from "@/store/appStore";

export function useRepo() {
  const { addRepo, setOperationInProgress } = useAppStore();

  // Opens each path as its own tab; failures are reported per path so one bad
  // folder doesn't block the rest.
  const openRepoPaths = useCallback(
    async (paths: string[]) => {
      for (const path of paths) {
        try {
          const repo = await git.openRepo(path);
          await git.addRecentRepo(path);
          addRepo(repo);
        } catch (e) {
          toast.error(`Failed to open repo ${path}: ${e}`);
        }
      }
    },
    [addRepo]
  );

  const openRepo = useCallback(async () => {
    const selected = await open({ directory: true, multiple: true });
    if (!selected) return;
    await openRepoPaths(Array.isArray(selected) ? selected : [selected]);
  }, [openRepoPaths]);

  const openRepoFromPath = useCallback(
    async (path: string) => {
      try {
        const repo = await git.openRepo(path);
        addRepo(repo);
      } catch (e) {
        toast.error(`Failed to open repo: ${e}`);
      }
    },
    [addRepo]
  );

  const withOp = useCallback(
    async (fn: () => Promise<void>, successMsg?: string) => {
      setOperationInProgress(true);
      try {
        await fn();
        if (successMsg) toast.success(successMsg);
      } catch (e) {
        toast.error(String(e));
      } finally {
        setOperationInProgress(false);
      }
    },
    [setOperationInProgress]
  );

  return { openRepo, openRepoFromPath, openRepoPaths, withOp };
}
