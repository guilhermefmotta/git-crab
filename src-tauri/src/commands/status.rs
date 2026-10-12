use crate::git::types::{FileStatus, FileStatusKind};
use git2::{IndexAddOption, Repository, Status};

fn apply_patch(repo_path: &str, patch: &str, reverse: bool) -> Result<(), String> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let mut args = vec!["apply", "--cached", "--whitespace=nowarn", "--unidiff-zero"];
    if reverse {
        args.push("--reverse");
    }

    let mut child = Command::new("git")
        .args(&args)
        .current_dir(repo_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("git not found: {}", e))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(patch.as_bytes()).map_err(|e| e.to_string())?;
    }

    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn stage_hunk(repo_path: String, patch: String) -> Result<(), String> {
    apply_patch(&repo_path, &patch, false)
}

#[tauri::command]
pub async fn unstage_hunk(repo_path: String, patch: String) -> Result<(), String> {
    apply_patch(&repo_path, &patch, true)
}

fn map_status(s: Status, path: &str) -> Option<FileStatus> {
    let staged = s.intersects(
        Status::INDEX_NEW
            | Status::INDEX_MODIFIED
            | Status::INDEX_DELETED
            | Status::INDEX_RENAMED
            | Status::INDEX_TYPECHANGE,
    );
    let unstaged = s.intersects(
        Status::WT_MODIFIED | Status::WT_DELETED | Status::WT_TYPECHANGE | Status::WT_RENAMED,
    );
    let untracked = s.contains(Status::WT_NEW);
    let conflicted = s.contains(Status::CONFLICTED);

    let kind = match (conflicted, staged, unstaged, untracked) {
        (true, _, _, _) => FileStatusKind::Conflicted,
        (_, true, true, _) => FileStatusKind::StagedAndUnstaged,
        (_, true, false, _) => FileStatusKind::Staged,
        (_, false, true, _) => FileStatusKind::Unstaged,
        (_, false, false, true) => FileStatusKind::Untracked,
        _ => return None,
    };

    Some(FileStatus {
        path: path.to_string(),
        status: kind,
        old_path: None,
    })
}

#[tauri::command]
pub async fn get_status(repo_path: String) -> Result<Vec<FileStatus>, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.message().to_string())?;
    let statuses = repo
        .statuses(None)
        .map_err(|e| e.message().to_string())?;

    let result = statuses
        .iter()
        .filter_map(|entry| {
            let path = entry.path().unwrap_or("");
            map_status(entry.status(), path)
        })
        .collect();

    Ok(result)
}

#[tauri::command]
pub async fn stage_file(repo_path: String, file_path: String) -> Result<(), String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.message().to_string())?;
    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    index
        .add_path(std::path::Path::new(&file_path))
        .map_err(|e| e.message().to_string())?;
    index.write().map_err(|e| e.message().to_string())
}

#[tauri::command]
pub async fn unstage_file(repo_path: String, file_path: String) -> Result<(), String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.message().to_string())?;
    let head = repo.head().map_err(|e| e.message().to_string())?;
    let head_commit = head
        .peel_to_commit()
        .map_err(|e| e.message().to_string())?;
    let head_tree = head_commit
        .tree()
        .map_err(|e| e.message().to_string())?;

    repo.reset_default(
        Some(head_tree.as_object()),
        [file_path].iter(),
    )
    .map_err(|e| e.message().to_string())
}

#[tauri::command]
pub async fn stage_all(repo_path: String) -> Result<(), String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.message().to_string())?;
    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    // Conflicted files still hold <<<<<<< markers; staging them would mark the
    // conflict resolved with the markers committed. They leave the conflicted
    // state only through the resolver.
    let conflicted: std::collections::HashSet<std::path::PathBuf> = index
        .conflicts()
        .map_err(|e| e.message().to_string())?
        .filter_map(|c| c.ok())
        .filter_map(|c| c.our.or(c.their).or(c.ancestor))
        .filter_map(|e| String::from_utf8(e.path).ok().map(std::path::PathBuf::from))
        .collect();
    let mut skip_conflicted = |path: &std::path::Path, _spec: &[u8]| -> i32 {
        if conflicted.contains(path) { 1 } else { 0 }
    };
    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, Some(&mut skip_conflicted))
        .map_err(|e| e.message().to_string())?;
    index.write().map_err(|e| e.message().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &std::path::Path, args: &[&str]) {
        let ok = Command::new("git").args(args).current_dir(dir).output().unwrap().status.success();
        assert!(ok || args[0] == "merge", "git {:?} failed", args);
    }

    /// Unstaging everything mid-merge must keep the merge in progress
    #[tokio::test]
    async fn unstage_all_keeps_merge_state() {
        let dir = std::env::temp_dir().join(format!("gitcrab-unstage-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["config", "user.email", "t@t"]);
        git(&dir, &["config", "user.name", "t"]);
        std::fs::write(dir.join("f.txt"), "base\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "base"]);
        git(&dir, &["checkout", "-qb", "other"]);
        std::fs::write(dir.join("f.txt"), "theirs\n").unwrap();
        git(&dir, &["commit", "-qam", "theirs"]);
        git(&dir, &["checkout", "-q", "main"]);
        std::fs::write(dir.join("f.txt"), "ours\n").unwrap();
        git(&dir, &["commit", "-qam", "ours"]);
        git(&dir, &["merge", "other"]);
        std::fs::write(dir.join("f.txt"), "resolved\n").unwrap();
        git(&dir, &["add", "f.txt"]);

        unstage_all(dir.to_string_lossy().to_string()).await.unwrap();

        assert!(dir.join(".git/MERGE_HEAD").exists(), "merge was aborted");
        assert_eq!(std::fs::read_to_string(dir.join("f.txt")).unwrap(), "resolved\n");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[tauri::command]
pub async fn unstage_all(repo_path: String) -> Result<(), String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.message().to_string())?;
    let head = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok());

    if let Some(commit) = head {
        // Path-limited reset (`git reset -- <paths>`), not a whole-repo mixed
        // reset: libgit2's git_reset also clears MERGE_HEAD/MERGE_MSG, which
        // silently aborted an in-progress merge.
        let staged: Vec<String> = repo
            .statuses(None)
            .map_err(|e| e.message().to_string())?
            .iter()
            .filter(|e| {
                e.status().intersects(
                    Status::INDEX_NEW | Status::INDEX_MODIFIED | Status::INDEX_DELETED
                        | Status::INDEX_RENAMED | Status::INDEX_TYPECHANGE,
                )
            })
            .filter_map(|e| e.path().map(str::to_string))
            .collect();
        if staged.is_empty() {
            return Ok(());
        }
        repo.reset_default(Some(commit.as_object()), staged.iter())
            .map_err(|e| e.message().to_string())
    } else {
        // No commits yet — just clear the index
        let mut index = repo.index().map_err(|e| e.message().to_string())?;
        index.clear().map_err(|e| e.message().to_string())?;
        index.write().map_err(|e| e.message().to_string())
    }
}

#[tauri::command]
pub async fn discard_changes(repo_path: String, file_path: String) -> Result<(), String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.message().to_string())?;
    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.path(&file_path).force();
    repo.checkout_head(Some(&mut checkout))
        .map_err(|e| e.message().to_string())
}

#[tauri::command]
pub async fn ignore_file(repo_path: String, file_path: String) -> Result<(), String> {
    let gitignore = std::path::Path::new(&repo_path).join(".gitignore");
    let existing = if gitignore.exists() {
        std::fs::read_to_string(&gitignore).map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    let entry = if existing.ends_with('\n') || existing.is_empty() {
        format!("{file_path}\n")
    } else {
        format!("\n{file_path}\n")
    };
    std::fs::write(&gitignore, existing + &entry).map_err(|e| e.to_string())
}
