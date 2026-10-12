import { invoke } from "@tauri-apps/api/core";
import type {
  RepoInfo,
  CommitInfo,
  FileStatus,
  FileDiff,
  BranchInfo,
  RemoteInfo,
  StashInfo,
  TagInfo,
  SearchResult,
} from "./types";
import type { RepoStatus, ConflictContent, MergeOutcome, CheckoutOutcome } from "./mergeTypes";

export { invoke };

export const git = {
  // Repo
  openRepo: (path: string) => invoke<RepoInfo>("open_repo", { path }),
  initRepo: (path: string) => invoke<RepoInfo>("init_repo", { path }),
  cloneRepo: (url: string, path: string) => invoke<RepoInfo>("clone_repo", { url, path }),
  getRecentRepos: () => invoke<string[]>("get_recent_repos"),
  addRecentRepo: (path: string) => invoke<void>("add_recent_repo", { path }),
  removeRecentRepo: (path: string) => invoke<void>("remove_recent_repo", { path }),

  // Status
  getStatus: (repoPath: string) => invoke<FileStatus[]>("get_status", { repoPath }),
  stageFile: (repoPath: string, filePath: string) =>
    invoke<void>("stage_file", { repoPath, filePath }),
  unstageFile: (repoPath: string, filePath: string) =>
    invoke<void>("unstage_file", { repoPath, filePath }),
  stageAll: (repoPath: string) => invoke<void>("stage_all", { repoPath }),
  unstageAll: (repoPath: string) => invoke<void>("unstage_all", { repoPath }),
  stageHunk: (repoPath: string, patch: string) =>
    invoke<void>("stage_hunk", { repoPath, patch }),
  unstageHunk: (repoPath: string, patch: string) =>
    invoke<void>("unstage_hunk", { repoPath, patch }),
  discardChanges: (repoPath: string, filePath: string) =>
    invoke<void>("discard_changes", { repoPath, filePath }),

  // Log
  getCommits: (repoPath: string, limit?: number, offset?: number, branch?: string) =>
    invoke<CommitInfo[]>("get_commits", { repoPath, limit, offset, branch }),

  // Diff
  getDiff: (
    repoPath: string,
    opts: { filePath?: string; commitHash?: string; staged?: boolean }
  ) => invoke<FileDiff[]>("get_diff", { repoPath, ...opts }),

  // Commit
  createCommit: (repoPath: string, message: string) =>
    invoke<string>("create_commit", { repoPath, message }),
  amendCommit: (repoPath: string, message: string) =>
    invoke<string>("amend_commit", { repoPath, message }),
  undoLastCommit: (repoPath: string) =>
    invoke<void>("undo_last_commit", { repoPath }),

  // Branches
  getBranches: (repoPath: string) => invoke<BranchInfo[]>("get_branches", { repoPath }),
  createBranch: (repoPath: string, name: string, fromHash?: string, checkout?: boolean) =>
    invoke<void>("create_branch", { repoPath, name, fromHash, checkout }),
  checkoutBranch: (repoPath: string, name: string) =>
    invoke<void>("checkout_branch", { repoPath, name }),
  deleteBranch: (repoPath: string, name: string, force?: boolean) =>
    invoke<void>("delete_branch", { repoPath, name, force }),
  renameBranch: (repoPath: string, name: string, newName: string) =>
    invoke<void>("rename_branch", { repoPath, name, newName }),
  rebaseBranch: (repoPath: string, branchName: string) =>
    invoke<MergeOutcome>("rebase_branch", { repoPath, branchName }),

  // Merge / conflict workflow
  getRepoStatus: (repoPath: string) =>
    invoke<RepoStatus>("get_repo_status", { repoPath }),
  getConflictContent: (repoPath: string, filePath: string) =>
    invoke<ConflictContent>("get_conflict_content", { repoPath, filePath }),
  resolveConflict: (repoPath: string, filePath: string, content: string) =>
    invoke<void>("resolve_conflict", { repoPath, filePath, content }),
  abortOperation: (repoPath: string) =>
    invoke<void>("abort_operation", { repoPath }),
  completeMergeCommit: (repoPath: string, message?: string) =>
    invoke<void>("complete_merge_commit", { repoPath, message }),
  continueOperation: (repoPath: string) =>
    invoke<RepoStatus>("continue_operation", { repoPath }),
  smartCheckout: (repoPath: string, name: string) =>
    invoke<CheckoutOutcome>("smart_checkout", { repoPath, name }),
  doMerge: (repoPath: string, branchName: string) =>
    invoke<MergeOutcome>("do_merge", { repoPath, branchName }),

  // Commit operations
  cherryPick: (repoPath: string, commitHash: string) =>
    invoke<void>("cherry_pick", { repoPath, commitHash }),
  revertCommit: (repoPath: string, commitHash: string) =>
    invoke<void>("revert_commit", { repoPath, commitHash }),
  resetToCommit: (repoPath: string, commitHash: string, mode: string) =>
    invoke<void>("reset_to_commit", { repoPath, commitHash, mode }),

  // Remote
  getRemotes: (repoPath: string) => invoke<RemoteInfo[]>("get_remotes", { repoPath }),
  fetchAll: (repoPath: string) => invoke<void>("fetch_all", { repoPath }),
  pull: (repoPath: string, rebase?: boolean) =>
    invoke<void>("pull", { repoPath, rebase }),
  push: (repoPath: string, force?: boolean) =>
    invoke<void>("push", { repoPath, force }),

  // Stash
  getStashes: (repoPath: string) => invoke<StashInfo[]>("get_stashes", { repoPath }),
  createStash: (repoPath: string, message?: string) =>
    invoke<void>("create_stash", { repoPath, message }),
  applyStash: (repoPath: string, index: number) =>
    invoke<void>("apply_stash", { repoPath, index }),
  popStash: (repoPath: string, index: number) =>
    invoke<void>("pop_stash", { repoPath, index }),
  dropStash: (repoPath: string, index: number) =>
    invoke<void>("drop_stash", { repoPath, index }),

  // Tags
  getTags: (repoPath: string) => invoke<TagInfo[]>("get_tags", { repoPath }),
  createTag: (repoPath: string, name: string, commitHash?: string, message?: string) =>
    invoke<void>("create_tag", { repoPath, name, commitHash, message }),
  deleteTag: (repoPath: string, name: string) =>
    invoke<void>("delete_tag", { repoPath, name }),

  // Log
  getFileHistory: (repoPath: string, filePath: string, limit?: number, offset?: number) =>
    invoke<import("./types").CommitInfo[]>("get_file_history", { repoPath, filePath, limit, offset }),
  getReflog: (repoPath: string, limit?: number) =>
    invoke<import("./types").ReflogEntry[]>("get_reflog", { repoPath, limit }),
  searchCommits: (repoPath: string, query: string) =>
    invoke<import("./types").CommitInfo[]>("search_commits", { repoPath, query }),

  // Submodules
  getSubmodules: (repoPath: string) =>
    invoke<import("./types").SubmoduleInfo[]>("get_submodules", { repoPath }),

  // Interactive rebase
  getRebaseCommits: (repoPath: string, baseHash: string) =>
    invoke<import("./types").CommitInfo[]>("get_rebase_commits", { repoPath, baseHash }),
  startInteractiveRebase: (repoPath: string, baseHash: string, steps: { action: string; hash: string; message: string }[]) =>
    invoke<void>("start_interactive_rebase", { repoPath, baseHash, steps }),

  // Blame
  getBlame: (repoPath: string, filePath: string, commitHash?: string) =>
    invoke<import("./types").BlameLine[]>("get_blame", { repoPath, filePath, commitHash }),

  // Windows
  openCommitWindow: (hash: string, title: string) =>
    invoke<void>("open_commit_window", { hash, title }),
  openFileDiffWindow: (key: string, title: string) =>
    invoke<void>("open_file_diff_window", { key, title }),
  openFileHistoryWindow: (key: string, title: string) =>
    invoke<void>("open_file_history_window", { key, title }),
  openBlameWindow: (key: string, title: string) =>
    invoke<void>("open_blame_window", { key, title }),
  openEditorWindow: (key: string, title: string) =>
    invoke<void>("open_editor_window", { key, title }),
  openMergeWindow: (repoPath: string) =>
    invoke<void>("open_merge_window", { repoPath }),

  // File operations
  ignoreFile: (repoPath: string, filePath: string) =>
    invoke<void>("ignore_file", { repoPath, filePath }),
  listRepoFiles: (repoPath: string) =>
    invoke<string[]>("list_repo_files", { repoPath }),
  getFileAtRef: (repoPath: string, rev: string, filePath: string) =>
    invoke<string>("get_file_at_ref", { repoPath, rev, filePath }),
  searchText: (repoPath: string, query: string, rev?: string, caseSensitive?: boolean) =>
    invoke<SearchResult>("search_text", { repoPath, query, rev, caseSensitive }),
  getFileContent: (repoPath: string, filePath: string) =>
    invoke<string>("get_file_content", { repoPath, filePath }),
  writeFileContent: (repoPath: string, filePath: string, content: string) =>
    invoke<void>("write_file_content", { repoPath, filePath, content }),

  // Shell
  openInEditor: (filePath: string) => invoke<void>("open_path", { path: filePath }),
  showInFolder: (dirPath: string) => invoke<void>("open_path", { path: dirPath }),

  // Forge (GitHub / GitLab)
  openForgeWindow: (repoPath: string) =>
    invoke<void>("open_forge_window", { repoPath }),
  detectForge: (repoPath: string) =>
    invoke<import("./forgeTypes").ForgeInfo>("detect_forge", { repoPath }),
  saveForgeToken: (platform: string, token: string) =>
    invoke<void>("save_forge_token", { platform, token }),
  getPullRequests: (repoPath: string) =>
    invoke<import("./forgeTypes").PullRequest[]>("get_pull_requests", { repoPath }),
  getPipelines: (repoPath: string) =>
    invoke<import("./forgeTypes").Pipeline[]>("get_pipelines", { repoPath }),
  getPrComments: (repoPath: string, prNumber: number) =>
    invoke<import("./forgeTypes").PrComment[]>("get_pr_comments", { repoPath, prNumber }),
  postPrComment: (repoPath: string, prNumber: number, body: string) =>
    invoke<void>("post_pr_comment", { repoPath, prNumber, body }),
  triggerPipeline: (repoPath: string, refName: string) =>
    invoke<void>("trigger_pipeline", { repoPath, refName }),
  getPipelineJobs: (repoPath: string, pipelineId: number) =>
    invoke<import("./forgeTypes").PipelineJob[]>("get_pipeline_jobs", { repoPath, pipelineId }),
  retryPipelineJob: (repoPath: string, jobId: number) =>
    invoke<void>("retry_pipeline_job", { repoPath, jobId }),
};
