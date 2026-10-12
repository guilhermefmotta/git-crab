import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

// Cross-window "this repo changed" signal. Secondary windows (merge resolver,
// editor…) mutate the repo on their own; the main window listens and reloads
// status, branches and the commit graph so it never shows stale state.

const REPO_CHANGED = "repo-changed";

export function emitRepoChanged(repoPath: string) {
  emit(REPO_CHANGED, { repoPath }).catch(() => {});
}

export function onRepoChanged(cb: (repoPath: string) => void): Promise<UnlistenFn> {
  return listen<{ repoPath: string }>(REPO_CHANGED, (e) => cb(e.payload.repoPath));
}
