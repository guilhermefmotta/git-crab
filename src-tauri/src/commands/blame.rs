use git2::{BlameOptions, Repository};
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
pub struct BlameLine {
    pub line_no: usize,
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub timestamp: i64,
    pub content: String,
}

#[tauri::command]
pub async fn get_blame(
    repo_path: String,
    file_path: String,
    commit_hash: Option<String>,
) -> Result<Vec<BlameLine>, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.message().to_string())?;

    let mut opts = BlameOptions::new();
    if let Some(hash) = &commit_hash {
        let oid = git2::Oid::from_str(hash).map_err(|e| e.message().to_string())?;
        opts.newest_commit(oid);
    }

    let blame = repo
        .blame_file(Path::new(&file_path), Some(&mut opts))
        .map_err(|e| e.message().to_string())?;

    let workdir = repo
        .workdir()
        .ok_or_else(|| "Bare repository not supported".to_string())?;
    let full_path = workdir.join(&file_path);
    let raw = std::fs::read_to_string(&full_path)
        .map_err(|e| format!("Cannot read file: {}", e))?;
    let file_lines: Vec<&str> = raw.lines().collect();

    let mut result: Vec<BlameLine> = Vec::new();

    for hunk in blame.iter() {
        let commit_id = hunk.final_commit_id();
        let commit = repo
            .find_commit(commit_id)
            .map_err(|e| e.message().to_string())?;
        let hash_str = commit_id.to_string();
        let short_hash = hash_str[..7.min(hash_str.len())].to_string();
        let author = commit.author().name().unwrap_or("").to_string();
        let timestamp = commit.time().seconds();
        let start = hunk.final_start_line(); // 1-indexed
        let count = hunk.lines_in_hunk();

        for i in 0..count {
            let line_no = start + i;
            let content = file_lines
                .get(line_no - 1)
                .copied()
                .unwrap_or("")
                .to_string();
            result.push(BlameLine {
                line_no,
                hash: hash_str.clone(),
                short_hash: short_hash.clone(),
                author: author.clone(),
                timestamp,
                content,
            });
        }
    }

    result.sort_by_key(|l| l.line_no);
    Ok(result)
}

#[derive(Serialize, Clone)]
pub struct LineAuthor {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub timestamp: i64,
    pub summary: String,
}

/// Per-line authorship for the editor, one entry per line of `content`.
/// With `rev`, blames the file as of that ref (read-only views). Otherwise the
/// committed blame is applied to the editor buffer, so lines that are edited
/// but not committed come back as `None`.
#[tauri::command]
pub async fn get_line_authors(
    repo_path: String,
    file_path: String,
    content: String,
    rev: Option<String>,
) -> Result<Vec<Option<LineAuthor>>, String> {
    tokio::task::spawn_blocking(move || {
        let repo = Repository::open(&repo_path).map_err(|e| e.message().to_string())?;
        let line_count = content.lines().count();

        let mut opts = BlameOptions::new();
        if let Some(rev) = &rev {
            let commit = repo
                .revparse_single(rev)
                .and_then(|o| o.peel_to_commit())
                .map_err(|e| e.message().to_string())?;
            opts.newest_commit(commit.id());
        }

        // Untracked / never committed: nobody to blame yet
        let Ok(committed) = repo.blame_file(Path::new(&file_path), Some(&mut opts)) else {
            return Ok(vec![None; line_count]);
        };
        let blame = if rev.is_some() {
            committed
        } else {
            committed
                .blame_buffer(content.as_bytes())
                .map_err(|e| e.message().to_string())?
        };

        let mut cache: std::collections::HashMap<git2::Oid, Option<LineAuthor>> =
            std::collections::HashMap::new();
        let mut out: Vec<Option<LineAuthor>> = vec![None; line_count];

        for hunk in blame.iter() {
            let oid = hunk.final_commit_id();
            let info = cache
                .entry(oid)
                .or_insert_with(|| {
                    // Zero id = lines from the buffer that aren't in any commit
                    if oid.is_zero() {
                        return None;
                    }
                    repo.find_commit(oid).ok().map(|c| {
                        let hash = oid.to_string();
                        LineAuthor {
                            short_hash: hash[..7].to_string(),
                            hash,
                            author: c.author().name().unwrap_or("").to_string(),
                            timestamp: c.time().seconds(),
                            summary: c.summary().unwrap_or("").to_string(),
                        }
                    })
                })
                .clone();
            let start = hunk.final_start_line(); // 1-indexed
            for i in 0..hunk.lines_in_hunk() {
                if let Some(slot) = out.get_mut(start + i - 1) {
                    *slot = info.clone();
                }
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// LINE_AUTHORS_REPO=... LINE_AUTHORS_FILE=... cargo test line_authors -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn line_authors_against_repo() {
        let repo = std::env::var("LINE_AUTHORS_REPO").unwrap();
        let file = std::env::var("LINE_AUTHORS_FILE").unwrap();
        let content = std::fs::read_to_string(Path::new(&repo).join(&file)).unwrap();
        let authors = get_line_authors(repo, file, content, None).await.unwrap();
        for (i, a) in authors.iter().enumerate().skip(26).take(8) {
            println!("{:>3} {}", i + 1, a.as_ref().map_or("(uncommitted)".into(), |a| format!("{} {}", a.short_hash, a.author)));
        }
    }
}
