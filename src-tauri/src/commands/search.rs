use crate::commands::repo::workdir_files;
use git2::{ObjectType, Oid, Repository, TreeWalkMode, TreeWalkResult};
use serde::Serialize;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

/// Files above this size are skipped (lockfiles, bundles, data dumps).
const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_MATCHES: usize = 2000;
const MAX_MATCHES_PER_FILE: usize = 200;
const MAX_PREVIEW_CHARS: usize = 300;

#[derive(Debug, Serialize, Clone)]
pub struct SearchMatch {
    pub path: String,
    /// 1-based line number
    pub line: usize,
    /// UTF-16 offsets of the match inside `text`
    pub start: usize,
    pub end: usize,
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub matches: Vec<SearchMatch>,
    pub files_searched: usize,
    pub truncated: bool,
}

enum Source {
    Workdir(std::path::PathBuf, Vec<String>),
    Tree(Vec<(String, Oid)>),
}

impl Source {
    fn len(&self) -> usize {
        match self {
            Source::Workdir(_, files) => files.len(),
            Source::Tree(entries) => entries.len(),
        }
    }
}

/// Finds every occurrence of `needle` in `content`, one match per line.
fn search_content(path: &str, content: &[u8], needle: &[u8], case_sensitive: bool) -> Vec<SearchMatch> {
    // Binary files: NUL byte in the first 8 KiB, same heuristic git uses
    if content[..content.len().min(8192)].contains(&0) {
        return Vec::new();
    }
    let haystack: std::borrow::Cow<[u8]> = if case_sensitive {
        content.into()
    } else {
        content.to_ascii_lowercase().into()
    };

    let mut out = Vec::new();
    let mut pos = 0;
    let mut line_no = 1;
    let mut line_start = 0;
    while let Some(found) = find(&haystack[pos..], needle) {
        let at = pos + found;
        line_no += haystack[line_start..at].iter().filter(|&&b| b == b'\n').count();
        line_start = haystack[..at].iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
        let line_end = haystack[at..].iter().position(|&b| b == b'\n').map_or(haystack.len(), |i| at + i);

        let line = String::from_utf8_lossy(&content[line_start..line_end]);
        let col = String::from_utf8_lossy(&content[line_start..at]).len();
        let (text, start) = preview(&line, col);
        let end = (start + needle.len()).min(text.len());
        // The UI indexes JS strings, so convert byte offsets to UTF-16 units
        let utf16 = |byte: usize| text.get(..byte).map_or(0, |s| s.encode_utf16().count());
        out.push(SearchMatch {
            path: path.to_string(),
            line: line_no,
            start: utf16(start),
            end: utf16(end).max(utf16(start)),
            text,
        });
        if out.len() >= MAX_MATCHES_PER_FILE {
            break;
        }
        // One match per line; continue on the next line
        pos = line_end.min(haystack.len());
        line_start = pos;
        if pos >= haystack.len() {
            break;
        }
    }
    out
}

/// Trims long lines around the match so the UI gets a readable snippet.
fn preview(line: &str, col: usize) -> (String, usize) {
    let trimmed_start = line.len() - line.trim_start().len();
    let mut from = if col > 80 { col - 60 } else { trimmed_start.min(col) };
    while !line.is_char_boundary(from) {
        from -= 1;
    }
    let mut to = (from + MAX_PREVIEW_CHARS).min(line.len());
    while !line.is_char_boundary(to) {
        to -= 1;
    }
    let prefix = if from > trimmed_start { "…" } else { "" };
    (format!("{}{}", prefix, &line[from..to].trim_end()), col - from + prefix.len())
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    let first = needle[0];
    let last_start = haystack.len() - needle.len();
    let mut i = 0;
    while i <= last_start {
        match haystack[i..=last_start].iter().position(|&b| b == first) {
            None => return None,
            Some(off) => {
                i += off;
                if &haystack[i..i + needle.len()] == needle {
                    return Some(i);
                }
                i += 1;
            }
        }
    }
    None
}

fn run_search(
    repo_path: &str,
    query: &str,
    rev: Option<&str>,
    case_sensitive: bool,
) -> Result<SearchResult, String> {
    let repo = Repository::open(repo_path).map_err(|e| e.message().to_string())?;

    let source = match rev {
        None => {
            let workdir = repo
                .workdir()
                .ok_or_else(|| "Bare repository has no working tree".to_string())?
                .to_path_buf();
            Source::Workdir(workdir, workdir_files(&repo)?)
        }
        Some(rev) => {
            let tree = repo
                .revparse_single(rev)
                .and_then(|o| o.peel_to_tree())
                .map_err(|e| e.message().to_string())?;
            let mut entries = Vec::new();
            tree.walk(TreeWalkMode::PreOrder, |dir, entry| {
                if entry.kind() == Some(ObjectType::Blob) {
                    if let Some(name) = entry.name() {
                        entries.push((format!("{}{}", dir, name), entry.id()));
                    }
                }
                TreeWalkResult::Ok
            })
            .map_err(|e| e.message().to_string())?;
            Source::Tree(entries)
        }
    };
    drop(repo);

    let needle: Vec<u8> = if case_sensitive {
        query.as_bytes().to_vec()
    } else {
        query.to_ascii_lowercase().into_bytes()
    };

    let total = source.len();
    let next = AtomicUsize::new(0);
    let found = AtomicUsize::new(0);
    let results: Mutex<Vec<SearchMatch>> = Mutex::new(Vec::new());
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(16);

    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| {
                // git2 handles aren't Sync, so each worker opens its own
                let thread_repo = match &source {
                    Source::Tree(_) => Repository::open(repo_path).ok(),
                    Source::Workdir(..) => None,
                };
                let mut local = Vec::new();
                loop {
                    if found.load(Ordering::Relaxed) >= MAX_MATCHES {
                        break;
                    }
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= total {
                        break;
                    }
                    let matches = match &source {
                        Source::Workdir(root, files) => {
                            let path = &files[i];
                            let full = root.join(path);
                            match std::fs::metadata(&full) {
                                Ok(m) if (m.len() as usize) <= MAX_FILE_BYTES => {}
                                _ => continue,
                            }
                            match std::fs::read(&full) {
                                Ok(bytes) => search_content(path, &bytes, &needle, case_sensitive),
                                Err(_) => continue,
                            }
                        }
                        Source::Tree(entries) => {
                            let (path, oid) = &entries[i];
                            let Some(r) = &thread_repo else { break };
                            let Ok(blob) = r.find_blob(*oid) else { continue };
                            if blob.size() > MAX_FILE_BYTES {
                                continue;
                            }
                            search_content(path, blob.content(), &needle, case_sensitive)
                        }
                    };
                    if !matches.is_empty() {
                        found.fetch_add(matches.len(), Ordering::Relaxed);
                        local.extend(matches);
                    }
                }
                results.lock().unwrap().extend(local);
            });
        }
    });

    let mut matches = results.into_inner().unwrap();
    matches.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    let truncated = matches.len() >= MAX_MATCHES;
    matches.truncate(MAX_MATCHES);

    Ok(SearchResult {
        matches,
        files_searched: total,
        truncated,
    })
}

/// Text search across the repo. `rev: None` searches the working tree as it is
/// on disk (including uncommitted edits); `rev: Some(branch)` searches that
/// branch's committed tree straight from the object database, no checkout.
#[tauri::command]
pub async fn search_text(
    repo_path: String,
    query: String,
    rev: Option<String>,
    case_sensitive: Option<bool>,
) -> Result<SearchResult, String> {
    if query.is_empty() {
        return Ok(SearchResult { matches: Vec::new(), files_searched: 0, truncated: false });
    }
    tokio::task::spawn_blocking(move || {
        run_search(&repo_path, &query, rev.as_deref(), case_sensitive.unwrap_or(false))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_one_match_per_line_with_line_numbers() {
        let content = b"alpha\nbeta Foo foo\n\nfoo end";
        let m = search_content("f.txt", content, b"foo", false);
        assert_eq!(m.len(), 2);
        assert_eq!((m[0].line, m[0].start, m[0].end), (2, 5, 8));
        assert_eq!(m[0].text, "beta Foo foo");
        assert_eq!((m[1].line, m[1].start), (4, 0));
    }

    #[test]
    fn case_sensitive_and_binary() {
        assert_eq!(search_content("f", b"Foo foo", b"Foo", true).len(), 1);
        assert!(search_content("f", b"foo\0bar", b"foo", false).is_empty());
    }

    #[test]
    fn utf16_offsets_after_multibyte_chars() {
        let m = search_content("f", "ação = needle".as_bytes(), b"needle", false);
        assert_eq!((m[0].start, m[0].end), (7, 13));
    }

    /// SEARCH_BENCH_REPO=/path/to/repo cargo test --release bench -- --ignored --nocapture
    #[test]
    #[ignore]
    fn bench() {
        let repo = std::env::var("SEARCH_BENCH_REPO").expect("SEARCH_BENCH_REPO");
        for rev in [None, Some("HEAD")] {
            let t = std::time::Instant::now();
            let r = run_search(&repo, &std::env::var("SEARCH_BENCH_Q").unwrap_or("func".into()), rev, false).unwrap();
            println!("{:?}: {} files, {} matches in {:?}", rev, r.files_searched, r.matches.len(), t.elapsed());
        }
    }
}
