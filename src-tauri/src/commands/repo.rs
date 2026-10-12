use crate::git::types::RemoteInfo;
use git2::{build::RepoBuilder, FetchOptions, RemoteCallbacks, Repository};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize)]
pub struct RepoInfo {
    pub path: String,
    pub name: String,
    pub head_branch: Option<String>,
    pub remotes: Vec<RemoteInfo>,
}

fn config_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("git_crab")
        .join("recent.json")
}

#[tauri::command]
pub async fn open_repo(path: String) -> Result<RepoInfo, String> {
    let repo = Repository::open(&path).map_err(|e| e.message().to_string())?;

    let head_branch = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(|s| s.to_string()));

    let remotes: Vec<RemoteInfo> = repo
        .remotes()
        .map(|names| {
            names
                .iter()
                .flatten()
                .filter_map(|name| {
                    repo.find_remote(name).ok().map(|r| RemoteInfo {
                        name: name.to_string(),
                        url: r.url().unwrap_or("").to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let name = PathBuf::from(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("repo")
        .to_string();

    Ok(RepoInfo {
        path,
        name,
        head_branch,
        remotes,
    })
}

#[tauri::command]
pub async fn init_repo(path: String) -> Result<RepoInfo, String> {
    Repository::init(&path).map_err(|e| e.message().to_string())?;
    open_repo(path).await
}

#[tauri::command]
pub async fn clone_repo(url: String, path: String) -> Result<RepoInfo, String> {
    // All git2 objects dropped before the .await
    {
        let mut callbacks = RemoteCallbacks::new();
        callbacks.credentials(|_url, username, _allowed| {
            git2::Cred::ssh_key_from_agent(username.unwrap_or("git"))
        });

        let mut fetch_opts = FetchOptions::new();
        fetch_opts.remote_callbacks(callbacks);

        let mut builder = RepoBuilder::new();
        builder.fetch_options(fetch_opts);

        builder
            .clone(&url, std::path::Path::new(&path))
            .map_err(|e| e.message().to_string())?;
    }

    open_repo(path).await
}

#[tauri::command]
pub async fn get_recent_repos() -> Result<Vec<String>, String> {
    let path = config_path();
    if !path.exists() {
        return Ok(vec![]);
    }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let repos: Vec<String> = serde_json::from_str(&content).unwrap_or_default();
    // Filter out paths that no longer exist
    let valid: Vec<String> = repos
        .into_iter()
        .filter(|p| Repository::open(p).is_ok())
        .collect();
    Ok(valid)
}

#[tauri::command]
pub async fn add_recent_repo(path: String) -> Result<(), String> {
    let config = config_path();
    if let Some(parent) = config.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut repos = get_recent_repos().await.unwrap_or_default();
    repos.retain(|p| p != &path);
    repos.insert(0, path);
    repos.truncate(20);
    let content = serde_json::to_string(&repos).map_err(|e| e.to_string())?;
    std::fs::write(&config, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_recent_repo(path: String) -> Result<(), String> {
    let config = config_path();
    let mut repos = get_recent_repos().await.unwrap_or_default();
    repos.retain(|p| p != &path);
    let content = serde_json::to_string(&repos).map_err(|e| e.to_string())?;
    std::fs::write(&config, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_commit_window(
    app: tauri::AppHandle,
    hash: String,
    title: String,
) -> Result<(), String> {
    let label = format!("commit-{}", &hash[..hash.len().min(8)]);

    if let Some(win) = app.get_webview_window(&label) {
        win.set_focus().ok();
        return Ok(());
    }

    tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App(
            std::path::PathBuf::from(format!("index.html?view=commit&hash={}", hash)),
        ),
    )
    .title(title)
    .inner_size(1400.0, 900.0)
    .center()
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn open_file_diff_window(
    app: tauri::AppHandle,
    key: String,
    title: String,
) -> Result<(), String> {
    let label = format!("filediff-{}", key);

    if let Some(win) = app.get_webview_window(&label) {
        win.set_focus().ok();
        return Ok(());
    }

    tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App(
            std::path::PathBuf::from(format!("index.html?view=filediff&key={}", key)),
        ),
    )
    .title(title)
    .inner_size(1400.0, 900.0)
    .center()
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn open_merge_window(
    app: tauri::AppHandle,
    repo_path: String,
) -> Result<(), String> {
    let label = "merge-resolver";

    if let Some(win) = app.get_webview_window(label) {
        win.set_focus().ok();
        return Ok(());
    }

    // percent-encode the repo path so it's safe in a query string
    let encoded: String = repo_path.chars().flat_map(|c| {
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/') {
            vec![c]
        } else {
            format!("%{:02X}", c as u32).chars().collect()
        }
    }).collect();

    tauri::WebviewWindowBuilder::new(
        &app,
        label,
        tauri::WebviewUrl::App(
            std::path::PathBuf::from(format!("index.html?view=merge&repoPath={}", encoded)),
        ),
    )
    .title("Resolve Conflicts")
    .inner_size(1400.0, 860.0)
    .min_inner_size(900.0, 600.0)
    .center()
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn open_file_history_window(
    app: tauri::AppHandle,
    key: String,
    title: String,
) -> Result<(), String> {
    let label = format!("filehistory-{}", &key[..key.len().min(40)]);

    if let Some(win) = app.get_webview_window(&label) {
        win.set_focus().ok();
        return Ok(());
    }

    tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App(
            std::path::PathBuf::from(format!("index.html?view=filehistory&key={}", key)),
        ),
    )
    .title(title)
    .inner_size(1200.0, 800.0)
    .center()
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn open_blame_window(
    app: tauri::AppHandle,
    key: String,
    title: String,
) -> Result<(), String> {
    let label = format!("blame-{}", &key[..key.len().min(40)]);

    if let Some(win) = app.get_webview_window(&label) {
        win.set_focus().ok();
        return Ok(());
    }

    tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App(
            std::path::PathBuf::from(format!("index.html?view=blame&key={}", key)),
        ),
    )
    .title(title)
    .inner_size(1200.0, 800.0)
    .center()
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn open_editor_window(
    app: tauri::AppHandle,
    key: String,
    title: String,
) -> Result<(), String> {
    // Hash the whole key: truncating it would make files that share a long
    // path prefix collide on the same window
    let label = {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        key.hash(&mut h);
        format!("editor-{:016x}", h.finish())
    };

    if let Some(win) = app.get_webview_window(&label) {
        win.set_focus().ok();
        return Ok(());
    }

    tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App(
            std::path::PathBuf::from(format!("index.html?view=editor&key={}", key)),
        ),
    )
    .title(title)
    .inner_size(1100.0, 800.0)
    .center()
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Every file in the working tree that git cares about: tracked files still on
/// disk plus untracked files that aren't ignored. Paths are repo-relative.
pub fn workdir_files(repo: &Repository) -> Result<Vec<String>, String> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| "Bare repository has no working tree".to_string())?
        .to_path_buf();

    let mut files = std::collections::BTreeSet::new();

    let index = repo.index().map_err(|e| e.message().to_string())?;
    for entry in index.iter() {
        if let Ok(path) = std::str::from_utf8(&entry.path) {
            if workdir.join(path).is_file() {
                files.insert(path.to_string());
            }
        }
    }

    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| e.message().to_string())?;
    for entry in statuses.iter() {
        if entry.status().contains(git2::Status::WT_NEW) {
            if let Some(path) = entry.path() {
                files.insert(path.to_string());
            }
        }
    }

    Ok(files.into_iter().collect())
}

#[tauri::command]
pub async fn list_repo_files(repo_path: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let repo = Repository::open(&repo_path).map_err(|e| e.message().to_string())?;
        workdir_files(&repo)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// File content as of a branch/ref, read from the object database (no checkout).
#[tauri::command]
pub async fn get_file_at_ref(
    repo_path: String,
    rev: String,
    file_path: String,
) -> Result<String, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.message().to_string())?;
    let tree = repo
        .revparse_single(&rev)
        .and_then(|o| o.peel_to_tree())
        .map_err(|e| e.message().to_string())?;
    let entry = tree
        .get_path(std::path::Path::new(&file_path))
        .map_err(|e| e.message().to_string())?;
    let blob = repo
        .find_blob(entry.id())
        .map_err(|e| e.message().to_string())?;
    String::from_utf8(blob.content().to_vec()).map_err(|_| "File is not valid UTF-8".to_string())
}

#[tauri::command]
pub async fn get_file_content(repo_path: String, file_path: String) -> Result<String, String> {
    let full = std::path::Path::new(&repo_path).join(&file_path);
    std::fs::read_to_string(&full).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_file_content(
    repo_path: String,
    file_path: String,
    content: String,
) -> Result<(), String> {
    let full = std::path::Path::new(&repo_path).join(&file_path);
    std::fs::write(&full, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok(())
}
