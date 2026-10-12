use crate::git::types::{DiffHunk, DiffLine, DiffLineType, FileDiff};
use git2::{DiffLineType as GitDiffLineType, Repository};

fn parse_diff(diff: git2::Diff) -> Result<Vec<FileDiff>, String> {
    let mut files: Vec<FileDiff> = Vec::new();

    diff.print(git2::DiffFormat::Patch, |delta, hunk, line| {
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .and_then(|p| p.to_str())
            .unwrap_or("")
            .to_string();

        if files.last().map(|f: &FileDiff| &f.path) != Some(&path) {
            files.push(FileDiff {
                path: path.clone(),
                hunks: Vec::new(),
            });
        }

        let file = files.last_mut().unwrap();

        if let Some(h) = hunk {
            let header = std::str::from_utf8(h.header()).unwrap_or("").trim().to_string();
            if file.hunks.last().map(|hk: &DiffHunk| &hk.header) != Some(&header) {
                file.hunks.push(DiffHunk {
                    header,
                    lines: Vec::new(),
                });
            }
        }

        let content = std::str::from_utf8(line.content())
            .unwrap_or("")
            .trim_end_matches('\n')
            .to_string();

        let line_type = match line.origin_value() {
            GitDiffLineType::Addition => DiffLineType::Add,
            GitDiffLineType::Deletion => DiffLineType::Delete,
            GitDiffLineType::FileHeader | GitDiffLineType::HunkHeader => DiffLineType::Header,
            _ => DiffLineType::Context,
        };

        if let Some(hunk) = file.hunks.last_mut() {
            hunk.lines.push(DiffLine {
                content,
                line_type,
                old_lineno: line.old_lineno(),
                new_lineno: line.new_lineno(),
            });
        }

        true
    })
    .map_err(|e| e.message().to_string())?;

    Ok(files)
}

/// Diffs show each file in full (changes highlighted inline) instead of only
/// the changed hunks, so the viewer gets one hunk spanning every line.
fn apply_file_opts(opts: &mut git2::DiffOptions, file_path: Option<&str>) {
    if let Some(path) = file_path {
        opts.pathspec(path);
    }
    opts.context_lines(1_000_000);
    opts.interhunk_lines(1_000_000);
}

#[tauri::command]
pub async fn get_diff(
    repo_path: String,
    file_path: Option<String>,
    commit_hash: Option<String>,
    staged: Option<bool>,
) -> Result<Vec<FileDiff>, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.message().to_string())?;

    let diff = if let Some(hash) = commit_hash {
        let oid = git2::Oid::from_str(&hash).map_err(|e| e.message().to_string())?;
        let commit = repo.find_commit(oid).map_err(|e| e.message().to_string())?;
        let commit_tree = commit.tree().map_err(|e| e.message().to_string())?;
        let parent_tree = commit
            .parent(0)
            .ok()
            .and_then(|p| p.tree().ok());

        let mut opts = git2::DiffOptions::new();
        apply_file_opts(&mut opts, file_path.as_deref());

        repo.diff_tree_to_tree(
            parent_tree.as_ref(),
            Some(&commit_tree),
            Some(&mut opts),
        )
        .map_err(|e| e.message().to_string())?
    } else if staged.unwrap_or(false) {
        let head_tree = repo
            .head()
            .ok()
            .and_then(|h| h.peel_to_tree().ok());

        let mut opts = git2::DiffOptions::new();
        apply_file_opts(&mut opts, file_path.as_deref());

        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
            .map_err(|e| e.message().to_string())?
    } else {
        let mut opts = git2::DiffOptions::new();
        apply_file_opts(&mut opts, file_path.as_deref());
        repo.diff_index_to_workdir(None, Some(&mut opts))
            .map_err(|e| e.message().to_string())?
    };

    parse_diff(diff)
}
