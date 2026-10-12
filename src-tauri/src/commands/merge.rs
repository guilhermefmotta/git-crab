use git2::{BranchType, Repository, Signature, StashApplyOptions, StashFlags, Status};
use serde::{Deserialize, Serialize};

// ── Types ──────────────────────────────────────────────────────────────────────

// Variant names go over the wire as-is: the frontend's GitOperation union is
// PascalCase ("Merging", "Clean"…)
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub enum GitOperation {
    Clean,
    Merging,
    Rebasing,
    CherryPicking,
    Reverting,
    Bisecting,
    Conflicted, // index conflicts present but no formal git operation (e.g. stash pop)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub operation: GitOperation,
    pub conflicted_files: Vec<String>,
    pub head_branch: Option<String>,
    pub operation_label: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConflictContent {
    pub path: String,
    pub ancestor: String,
    pub ours: String,
    pub theirs: String,
    pub merged: String,
    pub our_label: String,
    pub their_label: String,
    pub is_binary: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcome {
    pub fast_forward: bool,
    pub conflicted_files: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutOutcome {
    pub switched_to: String,
    pub conflicted_files: Vec<String>,
}

// ── Internal helpers ───────────────────────────────────────────────────────────

fn head_branch_name(repo: &Repository) -> Option<String> {
    repo.head().ok().and_then(|h| h.shorthand().map(String::from))
}

fn blob_text(repo: &Repository, oid: git2::Oid) -> Option<String> {
    repo.find_blob(oid)
        .ok()
        .and_then(|b| std::str::from_utf8(b.content()).ok().map(String::from))
}


pub fn conflicted_paths(repo: &Repository) -> Result<Vec<String>, String> {
    // Use Status::CONFLICTED flag — same source as get_status(), reliable after
    // repo.merge() even if index stages haven't been flushed to disk yet.
    let statuses = repo.statuses(None).map_err(|e| e.message().to_string())?;
    let paths = statuses
        .iter()
        .filter(|e| e.status().contains(Status::CONFLICTED))
        .filter_map(|e| e.path().map(String::from))
        .collect();
    Ok(paths)
}

fn operation_label(repo: &Repository) -> Option<String> {
    // MERGE_HEAD → branch name being merged in
    let merge_head = repo.path().join("MERGE_HEAD");
    if merge_head.exists() {
        if let Ok(content) = std::fs::read_to_string(&merge_head) {
            let hash = content.trim().to_string();
            if let Ok(oid) = git2::Oid::from_str(&hash) {
                if let Ok(branches) = repo.branches(None) {
                    for b in branches.flatten() {
                        if b.0.get().target() == Some(oid) {
                            if let Ok(Some(name)) = b.0.name() {
                                return Some(name.to_string());
                            }
                        }
                    }
                }
                return Some(hash[..8.min(hash.len())].to_string());
            }
        }
    }

    // REBASE: step info
    for dir in ["rebase-merge", "rebase-apply"] {
        let p = repo.path().join(dir);
        if p.exists() {
            let step  = std::fs::read_to_string(p.join("msgnum")).ok();
            let total = std::fs::read_to_string(p.join("end")).ok();
            if let (Some(s), Some(t)) = (step, total) {
                return Some(format!("step {}/{}", s.trim(), t.trim()));
            }
        }
    }

    // CHERRY_PICK_HEAD
    let cp = repo.path().join("CHERRY_PICK_HEAD");
    if cp.exists() {
        if let Ok(h) = std::fs::read_to_string(&cp) {
            return Some(h.trim()[..8.min(h.trim().len())].to_string());
        }
    }

    None
}

fn run_git(workdir: &std::path::Path, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(workdir)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn force_conflict_block(ours: &str, theirs: &str, our_label: &str, their_label: &str) -> String {
    let ours_nl   = if ours.is_empty() || ours.ends_with('\n')   { "" } else { "\n" };
    let theirs_nl = if theirs.is_empty() || theirs.ends_with('\n') { "" } else { "\n" };
    format!("<<<<<<< {our_label}\n{ours}{ours_nl}=======\n{theirs}{theirs_nl}>>>>>>> {their_label}\n")
}

fn build_merged(ancestor: &str, ours: &str, theirs: &str, our_label: &str, their_label: &str) -> String {
    // Nested markers or one side entirely absent — can't feed into diffy safely
    if ours.contains("<<<<<<<") || theirs.contains("<<<<<<<")
        || ours.is_empty() || theirs.is_empty()
    {
        return force_conflict_block(ours, theirs, our_label, their_label);
    }
    let mut opts = diffy::MergeOptions::new();
    opts.set_conflict_style(diffy::ConflictStyle::Merge);
    match opts.merge(ancestor, ours, theirs) {
        Ok(clean) => clean,
        Err(conflict_text) => conflict_text,
    }
}

// ── Commands ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_repo_status(repo_path: String) -> Result<RepoStatus, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.message().to_string())?;

    let operation = match repo.state() {
        git2::RepositoryState::Merge => GitOperation::Merging,
        git2::RepositoryState::Rebase
        | git2::RepositoryState::RebaseInteractive
        | git2::RepositoryState::RebaseMerge => GitOperation::Rebasing,
        git2::RepositoryState::CherryPick
        | git2::RepositoryState::CherryPickSequence => GitOperation::CherryPicking,
        git2::RepositoryState::Revert
        | git2::RepositoryState::RevertSequence => GitOperation::Reverting,
        git2::RepositoryState::Bisect => GitOperation::Bisecting,
        _ => GitOperation::Clean,
    };

    let conflicted = conflicted_paths(&repo)?;

    let effective_op = if matches!(operation, GitOperation::Clean) && !conflicted.is_empty() {
        GitOperation::Conflicted
    } else {
        operation
    };

    Ok(RepoStatus {
        operation: effective_op,
        conflicted_files: conflicted,
        head_branch: head_branch_name(&repo),
        operation_label: operation_label(&repo),
    })
}

#[tauri::command]
pub async fn get_conflict_content(
    repo_path: String,
    file_path: String,
) -> Result<ConflictContent, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.message().to_string())?;
    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    index.read(true).ok();

    let our_label   = head_branch_name(&repo).unwrap_or_else(|| "HEAD".to_string());
    let their_label = operation_label(&repo).unwrap_or_else(|| "incoming".to_string());

    // Use conflicts() iterator — more reliable than index.get_path() for staged conflict entries
    let (ancestor_id, our_id, their_id) = {
        let conflicts = index.conflicts().map_err(|e| e.message().to_string())?;
        let mut ids = (None::<git2::Oid>, None::<git2::Oid>, None::<git2::Oid>);
        for c in conflicts {
            let c = c.map_err(|e| e.message().to_string())?;
            let path = c.our.as_ref()
                .or(c.their.as_ref())
                .or(c.ancestor.as_ref())
                .and_then(|e| std::str::from_utf8(&e.path).ok().map(String::from));
            if path.as_deref() == Some(&file_path) {
                ids = (
                    c.ancestor.map(|e| e.id),
                    c.our.map(|e| e.id),
                    c.their.map(|e| e.id),
                );
                break;
            }
        }
        ids
    };

    let ancestor = ancestor_id.and_then(|id| blob_text(&repo, id)).unwrap_or_default();
    let ours     = our_id.and_then(|id| blob_text(&repo, id)).unwrap_or_default();
    let theirs   = their_id.and_then(|id| blob_text(&repo, id)).unwrap_or_default();

    let is_binary = [ancestor_id, our_id, their_id]
        .iter()
        .flatten()
        .any(|&id| repo.find_blob(id).map(|b| std::str::from_utf8(b.content()).is_err()).unwrap_or(false));

    let merged = if is_binary {
        String::new()
    } else {
        build_merged(&ancestor, &ours, &theirs, &our_label, &their_label)
    };

    Ok(ConflictContent {
        path: file_path,
        ancestor,
        ours,
        theirs,
        merged,
        our_label,
        their_label,
        is_binary,
    })
}

#[tauri::command]
pub async fn resolve_conflict(
    repo_path: String,
    file_path: String,
    content: String,
) -> Result<(), String> {
    let repo    = Repository::open(&repo_path).map_err(|e| e.message().to_string())?;
    let workdir = repo.workdir().ok_or("no workdir")?.to_path_buf();

    let full = workdir.join(&file_path);
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&full, &content).map_err(|e| e.to_string())?;

    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    index
        .add_path(std::path::Path::new(&file_path))
        .map_err(|e| e.message().to_string())?;
    index.write().map_err(|e| e.message().to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn abort_operation(repo_path: String) -> Result<(), String> {
    let repo    = Repository::open(&repo_path).map_err(|e| e.message().to_string())?;
    let workdir = repo.workdir().ok_or("no workdir")?.to_path_buf();

    let args: &[&str] = match repo.state() {
        git2::RepositoryState::Merge => &["merge", "--abort"],
        git2::RepositoryState::Rebase
        | git2::RepositoryState::RebaseInteractive
        | git2::RepositoryState::RebaseMerge => &["rebase", "--abort"],
        git2::RepositoryState::CherryPick
        | git2::RepositoryState::CherryPickSequence => &["cherry-pick", "--abort"],
        git2::RepositoryState::Revert
        | git2::RepositoryState::RevertSequence => &["revert", "--abort"],
        _ => &["reset", "--merge"], // stash-pop / manual conflict state
    };

    run_git(&workdir, args).map(|_| ())
}

#[tauri::command]
pub async fn complete_merge_commit(repo_path: String, message: Option<String>) -> Result<(), String> {
    let repo    = Repository::open(&repo_path).map_err(|e| e.message().to_string())?;
    let workdir = repo.workdir().ok_or("no workdir")?.to_path_buf();

    let remaining = conflicted_paths(&repo)?;
    if !remaining.is_empty() {
        return Err(format!("{} file(s) still conflicted", remaining.len()));
    }

    let msg_arg;
    let mut args = vec!["commit", "--no-edit"];
    if let Some(ref m) = message {
        msg_arg = m.as_str();
        args.push("-m");
        args.push(msg_arg);
    }

    run_git(&workdir, &args).map(|_| ())
}

#[tauri::command]
pub async fn continue_operation(repo_path: String) -> Result<RepoStatus, String> {
    let repo    = Repository::open(&repo_path).map_err(|e| e.message().to_string())?;
    let workdir = repo.workdir().ok_or("no workdir")?.to_path_buf();

    let remaining = conflicted_paths(&repo)?;
    if !remaining.is_empty() {
        return Err(format!("{} file(s) still conflicted", remaining.len()));
    }

    let args: &[&str] = match repo.state() {
        git2::RepositoryState::Rebase
        | git2::RepositoryState::RebaseInteractive
        | git2::RepositoryState::RebaseMerge => &["rebase", "--continue"],
        git2::RepositoryState::CherryPick
        | git2::RepositoryState::CherryPickSequence => &["cherry-pick", "--continue"],
        git2::RepositoryState::Revert
        | git2::RepositoryState::RevertSequence => &["revert", "--continue"],
        _ => return Err("No continuable operation in progress".to_string()),
    };

    // GIT_EDITOR=true prevents interactive editor from opening
    let _ = std::process::Command::new("git")
        .args(args)
        .current_dir(&workdir)
        .env("GIT_EDITOR", "true")
        .output();

    drop(repo);
    get_repo_status(repo_path).await
}

#[tauri::command]
pub async fn smart_checkout(
    repo_path: String,
    name: String,
) -> Result<CheckoutOutcome, String> {
    // Refuse if index already has conflicts
    {
        let repo = Repository::open(&repo_path).map_err(|e| e.message().to_string())?;
        let existing = conflicted_paths(&repo)?;
        if !existing.is_empty() {
            return Err("Resolve existing conflicts before switching branches".to_string());
        }
    }

    // Stash everything (including untracked)
    {
        let mut repo = Repository::open(&repo_path).map_err(|e| e.message().to_string())?;
        let config   = repo.config().map_err(|e| e.message().to_string())?;
        let uname    = config.get_string("user.name").unwrap_or_else(|_| "Unknown".to_string());
        let email    = config.get_string("user.email").unwrap_or_else(|_| "unknown@example.com".to_string());
        let sig      = Signature::now(&uname, &email).map_err(|e| e.message().to_string())?;
        repo.stash_save(
            &sig,
            &format!("smart-checkout: before {}", name),
            Some(StashFlags::INCLUDE_UNTRACKED),
        ).map_err(|e| e.message().to_string())?;
    }

    // Checkout
    if let Err(e) = super::branch::checkout_branch(repo_path.clone(), name.clone()).await {
        // Restore stash on checkout failure
        if let Ok(mut repo) = Repository::open(&repo_path) {
            let _ = repo.stash_pop(0, Some(&mut StashApplyOptions::new()));
        }
        return Err(e);
    }

    // Pop stash (may create conflicts)
    {
        let mut repo = Repository::open(&repo_path).map_err(|e| e.message().to_string())?;
        let _ = repo.stash_pop(0, Some(&mut StashApplyOptions::new()));
    }

    let repo      = Repository::open(&repo_path).map_err(|e| e.message().to_string())?;
    let conflicts = conflicted_paths(&repo)?;

    Ok(CheckoutOutcome { switched_to: name, conflicted_files: conflicts })
}

#[tauri::command]
pub async fn do_merge(repo_path: String, branch_name: String) -> Result<MergeOutcome, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.message().to_string())?;

    let branch = repo
        .find_branch(&branch_name, BranchType::Local)
        .or_else(|_| repo.find_branch(&branch_name, BranchType::Remote))
        .map_err(|_| format!("cannot locate branch '{branch_name}'"))?;
    let annotated = repo
        .reference_to_annotated_commit(branch.get())
        .map_err(|e| e.message().to_string())?;
    let (analysis, _) = repo
        .merge_analysis(&[&annotated])
        .map_err(|e| e.message().to_string())?;

    if analysis.is_up_to_date() {
        return Ok(MergeOutcome { fast_forward: false, conflicted_files: vec![] });
    }

    if analysis.is_fast_forward() {
        let target        = branch.get().target().ok_or("no target")?;
        let target_commit = repo.find_commit(target).map_err(|e| e.message().to_string())?;
        let mut head_ref  = repo.head().map_err(|e| e.message().to_string())?;
        head_ref
            .set_target(target, "fast-forward")
            .map_err(|e| e.message().to_string())?;
        let mut co = git2::build::CheckoutBuilder::new();
        co.force();
        repo.checkout_tree(target_commit.as_object(), Some(&mut co))
            .map_err(|e| e.message().to_string())?;
        return Ok(MergeOutcome { fast_forward: true, conflicted_files: vec![] });
    }

    repo.merge(&[&annotated], None, None)
        .map_err(|e| e.message().to_string())?;

    let conflicts = conflicted_paths(&repo)?;
    Ok(MergeOutcome { fast_forward: false, conflicted_files: conflicts })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frontend's GitOperation union is PascalCase ("Merging", "Clean"…)
    #[test]
    fn git_operation_serializes_like_the_frontend_type() {
        assert_eq!(serde_json::to_string(&GitOperation::Merging).unwrap(), "\"Merging\"");
        assert_eq!(serde_json::to_string(&GitOperation::Clean).unwrap(), "\"Clean\"");
        assert_eq!(serde_json::to_string(&GitOperation::CherryPicking).unwrap(), "\"CherryPicking\"");
    }

    fn git(dir: &std::path::Path, args: &[&str]) {
        run_git(dir, args).unwrap_or_else(|e| panic!("git {:?}: {}", args, e));
    }

    fn write(dir: &std::path::Path, file: &str, content: &str) {
        let p = dir.join(file);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }

    /// Same shape as the manual demo repo: two branches editing the same lines
    /// of three files, plus non-conflicting changes on both sides.
    fn conflict_repo(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("gitcrab-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["config", "user.email", "t@t"]);
        git(&dir, &["config", "user.name", "Tester"]);
        write(&dir, "config.go", "package config\n\nfunc Load() Config {\n\treturn Config{\n\t\tURL: \"local\",\n\t\tTimeout: 30,\n\t}\n}\n");
        write(&dir, "web/app.ts", "export function greet(name: string) {\n  return `Hello ${name}`;\n}\n\nexport const MAX = 3;\n");
        write(&dir, "README.md", "# Demo\n\nRun `make dev`.\n");
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-qm", "base"]);

        git(&dir, &["checkout", "-qb", "feature"]);
        write(&dir, "config.go", "package config\n\nfunc Load() Config {\n\treturn Config{\n\t\tURL: \"internal\",\n\t\tTimeout: 60,\n\t}\n}\n");
        write(&dir, "web/app.ts", "export function greet(name: string) {\n  return `Welcome ${name}`;\n}\n\nexport const MAX = 5;\n");
        write(&dir, "README.md", "# Demo\n\nRun `npm run dev`.\n");
        write(&dir, "web/feature.ts", "feature only\n");
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-qm", "feature"]);

        git(&dir, &["checkout", "-q", "main"]);
        write(&dir, "config.go", "package config\n\nfunc Load() Config {\n\treturn Config{\n\t\tURL: \"prod\",\n\t\tTimeout: 15,\n\t}\n}\n");
        write(&dir, "web/app.ts", "export function greet(name: string) {\n  return `Hi ${name}`;\n}\n\nexport const MAX = 3;\n");
        write(&dir, "README.md", "# Demo\n\nRun `docker compose up`.\n");
        git(&dir, &["commit", "-qam", "main"]);
        dir
    }

    /// The whole resolver flow the UI drives: merge → per-file Done
    /// (resolve_conflict) → Commit merge, with an "Unstage all" in the middle,
    /// ending in a clean repo with a two-parent merge commit.
    #[tokio::test]
    async fn merge_conflict_flow_end_to_end() {
        let dir = conflict_repo("merge-flow");
        let repo_path = dir.to_string_lossy().to_string();

        let outcome = do_merge(repo_path.clone(), "feature".into()).await.unwrap();
        let mut conflicted = outcome.conflicted_files.clone();
        conflicted.sort();
        assert_eq!(conflicted, vec!["README.md", "config.go", "web/app.ts"]);

        let status = get_repo_status(repo_path.clone()).await.unwrap();
        assert_eq!(status.operation, GitOperation::Merging);
        assert_eq!(status.conflicted_files.len(), 3);

        // Resolve each file the way the editor would: take "ours" for every
        // conflict (the resolver writes the full merged text)
        for (i, file) in conflicted.iter().enumerate() {
            let content = get_conflict_content(repo_path.clone(), file.clone()).await.unwrap();
            assert!(content.merged.contains("<<<<<<<"), "{file} should have markers");
            resolve_conflict(repo_path.clone(), file.clone(), content.ours.clone()).await.unwrap();

            // Unstaging mid-merge must not abort the merge
            if i == 0 {
                crate::commands::status::unstage_all(repo_path.clone()).await.unwrap();
                assert!(dir.join(".git/MERGE_HEAD").exists(), "unstage_all aborted the merge");
                // Unstaging also drops the cleanly merged files; "Stage all" brings them back
                crate::commands::status::stage_all(repo_path.clone()).await.unwrap();
            }

            let s = get_repo_status(repo_path.clone()).await.unwrap();
            assert_eq!(s.operation, GitOperation::Merging);
            assert_eq!(s.conflicted_files.len(), conflicted.len() - i - 1);
        }

        complete_merge_commit(repo_path.clone(), None).await.unwrap();

        // What the main window needs to stop showing the banner
        let done = get_repo_status(repo_path.clone()).await.unwrap();
        assert_eq!(done.operation, GitOperation::Clean);
        assert!(done.conflicted_files.is_empty());
        assert!(!dir.join(".git/MERGE_HEAD").exists());

        let repo = Repository::open(&dir).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_count(), 2, "expected a merge commit");
        let config = std::fs::read_to_string(dir.join("config.go")).unwrap();
        assert!(config.contains("\"prod\"") && config.contains("Timeout: 15,\n\t}"), "{config}");
        assert!(dir.join("web/feature.ts").exists(), "non-conflicting change from feature lost");
        let dirty: Vec<String> = repo.statuses(None).unwrap().iter()
            .map(|e| format!("{:?} {}", e.status(), e.path().unwrap_or(""))).collect();
        assert!(dirty.is_empty(), "working tree not clean: {dirty:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
