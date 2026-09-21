//! Surviving-line attribution from a pinned local Git revision.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{ipc::Channel, Manager, State};

#[derive(Default)]
pub struct ScanControl {
    running: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanOptions {
    repo: String,
    revision: String,
    group_by: GroupBy,
    pathspecs: Vec<String>,
    excludes: Vec<String>,
    include_generated: bool,
    ignore_whitespace: bool,
    exclude_bots: bool,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum GroupBy {
    Person,
    Email,
    Name,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    completed: usize,
    total: usize,
    phase: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorRow {
    author: String,
    names: Vec<String>,
    emails: Vec<String>,
    lines: u64,
    share: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    repo: String,
    revision: String,
    options: ScanOptions,
    files_blamed: usize,
    files_skipped: BTreeMap<String, usize>,
    total_lines: u64,
    credited_lines: u64,
    coauthored_lines: u64,
    authors: Vec<AuthorRow>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Ord, PartialOrd)]
struct Identity {
    name: String,
    email: String,
}
#[derive(Default)]
struct CommitLines {
    author: Identity,
    lines: u64,
}

fn git(repo: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Could not run Git. Install Git and try again: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(output.stdout)
}

fn git_text(repo: &Path, args: &[&str]) -> Result<String, String> {
    git(repo, args).map(|b| String::from_utf8_lossy(&b).into_owned())
}

fn normalize(name: &str) -> String {
    name.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}
fn identity_key(p: &Identity) -> String {
    if p.email.is_empty() {
        format!("name:{}", normalize(&p.name))
    } else {
        format!("email:{}", p.email)
    }
}
fn is_bot(p: &Identity) -> bool {
    let text = format!("{} {}", p.name, p.email).to_lowercase();
    text.contains("[bot]") || text.contains("copilot")
}

fn parse_blame(text: &str, commits: &mut BTreeMap<String, CommitLines>) {
    let mut sha = "";
    let mut author = Identity::default();
    for line in text.lines() {
        if line.starts_with('\t') {
            if !sha.is_empty() {
                let entry = commits.entry(sha.to_owned()).or_default();
                entry.author = author.clone();
                entry.lines += 1;
            }
        } else if let Some(name) = line.strip_prefix("author ") {
            author.name = name.to_owned();
        } else if let Some(email) = line.strip_prefix("author-mail ") {
            author.email = email
                .trim()
                .trim_start_matches('<')
                .trim_end_matches('>')
                .to_lowercase();
        } else if let Some(token) = line.split_whitespace().next() {
            if (token.len() == 40 || token.len() == 64)
                && token.bytes().all(|b| b.is_ascii_hexdigit())
            {
                sha = token;
                author = Identity::default();
            }
        }
    }
}

fn parse_coauthors(body: &str) -> Vec<Identity> {
    let mut people = BTreeSet::new();
    for line in body.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if !key.eq_ignore_ascii_case("co-authored-by") {
            continue;
        }
        let value = value.trim();
        let person = if let Some((name, email)) = value.rsplit_once('<') {
            Identity {
                name: name.trim().to_owned(),
                email: email.trim_end_matches('>').trim().to_lowercase(),
            }
        } else {
            Identity {
                name: value.to_owned(),
                email: String::new(),
            }
        };
        if !person.name.is_empty() || !person.email.is_empty() {
            people.insert(person);
        }
    }
    people.into_iter().collect()
}

fn root(parents: &BTreeMap<String, String>, key: &str) -> String {
    let mut current = key;
    while let Some(parent) = parents.get(current) {
        if parent == current {
            break;
        }
        current = parent;
    }
    current.to_owned()
}

fn aggregate(
    commits: &BTreeMap<String, CommitLines>,
    coauthors: &BTreeMap<String, Vec<Identity>>,
    group: GroupBy,
    exclude_bots: bool,
) -> (Vec<AuthorRow>, u64, u64) {
    let identities: Vec<_> = commits
        .values()
        .map(|c| &c.author)
        .chain(coauthors.values().flatten())
        .collect();
    let mut parents = BTreeMap::new();
    let mut by_name = BTreeMap::<String, String>::new();
    for person in identities {
        let key = identity_key(person);
        parents.entry(key.clone()).or_insert(key.clone());
        let name = normalize(&person.name);
        if !name.is_empty() {
            if let Some(other) = by_name.get(&name) {
                let left = root(&parents, other);
                let right = root(&parents, &key);
                parents.insert(right, left);
            } else {
                by_name.insert(name, key);
            }
        }
    }
    #[derive(Default)]
    struct Credit {
        lines: u64,
        names: BTreeMap<String, u64>,
        emails: BTreeMap<String, u64>,
    }
    let mut credits = BTreeMap::<String, Credit>::new();
    let mut total = 0;
    let mut coauthored = 0;
    for (sha, commit) in commits {
        let mut seen = BTreeSet::new();
        for person in
            std::iter::once(&commit.author).chain(coauthors.get(sha).into_iter().flatten())
        {
            if exclude_bots && is_bot(person) {
                continue;
            }
            let key = match group {
                GroupBy::Person => root(&parents, &identity_key(person)),
                GroupBy::Email => {
                    if person.email.is_empty() {
                        normalize(&person.name)
                    } else {
                        person.email.clone()
                    }
                }
                GroupBy::Name => {
                    if person.name.is_empty() {
                        person.email.clone()
                    } else {
                        normalize(&person.name)
                    }
                }
            };
            if key.is_empty() {
                continue;
            }
            let credit = credits.entry(key.clone()).or_default();
            // Keep every alias, but never credit the same identity twice for a line.
            if !person.name.is_empty() {
                *credit.names.entry(person.name.clone()).or_default() += commit.lines;
            }
            if !person.email.is_empty() {
                *credit.emails.entry(person.email.clone()).or_default() += commit.lines;
            }
            if seen.insert(key) {
                credit.lines += commit.lines;
            }
        }
        if !seen.is_empty() {
            total += commit.lines;
        }
        if seen.len() > 1 {
            coauthored += commit.lines;
        }
    }
    fn ranked(counts: BTreeMap<String, u64>) -> Vec<String> {
        let mut entries: Vec<_> = counts.into_iter().collect();
        entries.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        entries.into_iter().map(|(value, _)| value).collect()
    }
    let mut authors: Vec<_> = credits
        .into_values()
        .map(|credit| {
            let names = ranked(credit.names);
            let emails = ranked(credit.emails);
            let name = names
                .first()
                .or(emails.first())
                .cloned()
                .unwrap_or_else(|| "Unknown".into());
            let author = match group {
                GroupBy::Email => emails
                    .first()
                    .map(|e| format!("{name} <{e}>"))
                    .unwrap_or(name),
                GroupBy::Name => name,
                GroupBy::Person => names
                    .iter()
                    .find(|n| n.trim().contains(' '))
                    .cloned()
                    .unwrap_or(name),
            };
            AuthorRow {
                author,
                names,
                emails,
                lines: credit.lines,
                share: if total == 0 {
                    0.0
                } else {
                    credit.lines as f64 / total as f64
                },
            }
        })
        .collect();
    authors.sort_by(|a, b| {
        b.lines
            .cmp(&a.lines)
            .then(a.author.to_lowercase().cmp(&b.author.to_lowercase()))
    });
    (authors, total, coauthored)
}

const GENERATED: &[&str] = &[
    "*.lock",
    "*.lockb",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "Cargo.lock",
    "poetry.lock",
    "composer.lock",
    "Gemfile.lock",
    "go.sum",
    "*.min.js",
    "*.min.css",
    "*.map",
];
const BINARY: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "tif", "tiff", "ttf", "otf", "woff",
    "woff2", "eot", "pdf", "pptx", "ppt", "docx", "doc", "xlsx", "xls", "zip", "gz", "bz2", "xz",
    "7z", "wasm", "mp3", "mp4", "mov", "wav", "ogg", "webm", "bin", "exe", "dll", "so", "dylib",
    "class", "jar", "pyc", "pyo",
];

fn check_cancel(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::Relaxed) {
        Err("Scan cancelled".into())
    } else {
        Ok(())
    }
}

fn scan(
    options: ScanOptions,
    cancelled: &AtomicBool,
    progress: impl Fn(Progress),
) -> Result<Report, String> {
    let input = PathBuf::from(&options.repo);
    let bare = git_text(&input, &["rev-parse", "--is-bare-repository"])?;
    let repo = PathBuf::from(
        git_text(
            &input,
            &[
                "rev-parse",
                if bare.trim() == "true" {
                    "--absolute-git-dir"
                } else {
                    "--show-toplevel"
                },
            ],
        )?
        .trim_end(),
    );
    let rev = if options.revision.trim().is_empty() {
        "HEAD"
    } else {
        options.revision.trim()
    };
    // Pin once so a checkout or fetch during a scan cannot mix different revisions.
    let revision = git_text(
        &repo,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{rev}^{{commit}}"),
        ],
    )?
    .trim()
    .to_owned();
    if git_text(&repo, &["rev-parse", "--is-shallow-repository"])?.trim() == "true" {
        return Err("This clone has shallow history. Fetch its full history (git fetch --unshallow) before scanning.".into());
    }
    let patterns: Vec<glob::Pattern> = GENERATED
        .iter()
        .filter(|_| !options.include_generated)
        .copied()
        .chain(options.excludes.iter().map(String::as_str))
        .map(|p| glob::Pattern::new(p).map_err(|e| format!("Invalid exclude pattern {p}: {e}")))
        .collect::<Result<_, _>>()?;
    let mut args = vec!["ls-tree", "-r", "-z", &revision, "--"];
    args.extend(options.pathspecs.iter().map(String::as_str));
    let tree = git(&repo, &args)?;
    let mut files = Vec::new();
    let mut skipped = BTreeMap::<String, usize>::new();
    for entry in tree.split(|b| *b == 0).filter(|e| !e.is_empty()) {
        let entry = std::str::from_utf8(entry)
            .map_err(|_| "A tracked filename is not valid UTF-8; cannot scan it accurately.")?;
        let (meta, path) = entry.split_once('\t').ok_or("Invalid Git tree entry")?;
        let parts: Vec<_> = meta.split_whitespace().collect();
        if parts.len() != 3 {
            return Err("Invalid Git tree metadata".into());
        }
        let file = Path::new(path);
        let basename = file.file_name().and_then(|p| p.to_str()).unwrap_or(path);
        let suffix = file
            .extension()
            .and_then(|p| p.to_str())
            .unwrap_or("")
            .to_lowercase();
        let reason = if parts[0] == "160000" {
            Some("submodule")
        } else if parts[0] == "120000" {
            Some("symlink")
        } else if patterns
            .iter()
            .any(|p| p.matches(path) || p.matches(basename))
        {
            Some("generated / excluded")
        } else if BINARY.contains(&suffix.as_str()) {
            Some("binary")
        } else {
            None
        };
        if let Some(reason) = reason {
            *skipped.entry(reason.into()).or_default() += 1;
        } else {
            files.push((path.to_owned(), parts[2].to_owned()));
        }
    }
    let total = files.len();
    let mut commits = BTreeMap::new();
    let mut files_blamed = 0;
    progress(Progress {
        completed: 0,
        total,
        phase: "Blaming files".into(),
    });
    for (index, (path, blob)) in files.iter().enumerate() {
        check_cancel(cancelled)?;
        // Suffixes alone miss binary files with no extension. Inspect committed bytes.
        let content = git(&repo, &["cat-file", "blob", blob])?;
        if content.iter().take(8000).any(|b| *b == 0) {
            *skipped.entry("binary".into()).or_default() += 1;
        } else {
            let mut args = vec!["blame", "--line-porcelain", "--encoding=utf-8"];
            if options.ignore_whitespace {
                args.push("-w");
            }
            args.extend([&revision, "--", path]);
            match git_text(&repo, &args) {
                Ok(text) => {
                    parse_blame(&text, &mut commits);
                    files_blamed += 1;
                }
                Err(error) => {
                    *skipped
                        .entry(format!(
                            "blame failed: {}",
                            error.lines().next().unwrap_or("unknown error")
                        ))
                        .or_default() += 1;
                }
            }
        }
        progress(Progress {
            completed: index + 1,
            total,
            phase: "Blaming files".into(),
        });
    }
    check_cancel(cancelled)?;
    progress(Progress {
        completed: total,
        total,
        phase: "Reading co-authors".into(),
    });
    let shas: Vec<_> = commits.keys().map(String::as_str).collect();
    let mut coauthors = BTreeMap::new();
    for chunk in shas.chunks(200) {
        check_cancel(cancelled)?;
        let mut args = vec!["log", "--no-walk", "--format=%H%x00%B%x00"];
        args.extend_from_slice(chunk);
        args.push("--");
        let log = git_text(&repo, &args)?;
        let mut fields = log.split('\0');
        while let (Some(sha), Some(body)) = (fields.next(), fields.next()) {
            coauthors.insert(sha.trim().to_owned(), parse_coauthors(body));
        }
    }
    check_cancel(cancelled)?;
    let (authors, total_lines, coauthored_lines) =
        aggregate(&commits, &coauthors, options.group_by, options.exclude_bots);
    Ok(Report {
        repo: repo.to_string_lossy().into_owned(),
        revision,
        options,
        files_blamed,
        files_skipped: skipped,
        total_lines,
        credited_lines: authors.iter().map(|a| a.lines).sum(),
        coauthored_lines,
        authors,
    })
}

#[tauri::command]
pub async fn scan_line_ownership(
    mut options: ScanOptions,
    github_repo: Option<String>,
    token: Option<String>,
    app: tauri::AppHandle,
    on_progress: Channel<Progress>,
    control: State<'_, ScanControl>,
) -> Result<Report, String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("line-ownership");
    if control
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("A line ownership scan is already running".into());
    }
    control.cancelled.store(false, Ordering::SeqCst);
    let running = control.running.clone();
    let cancelled = control.cancelled.clone();
    tauri::async_runtime::spawn_blocking(move || {
        struct Reset(Arc<AtomicBool>);
        impl Drop for Reset {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _reset = Reset(running);
        if let Some(full_name) = &github_repo {
            let phase = |message: &str| {
                let _ = on_progress.send(Progress {
                    completed: 0,
                    total: 0,
                    phase: message.into(),
                });
            };
            options.repo = prepare_github(&cache, full_name, token.as_deref(), &cancelled, phase)?
                .to_string_lossy()
                .into_owned();
        }
        let mut report = scan(options, &cancelled, |event| {
            let _ = on_progress.send(event);
        })?;
        if let Some(full_name) = github_repo {
            report.repo = format!("https://github.com/{full_name}");
        }
        Ok(report)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn cancel_line_ownership(control: State<'_, ScanControl>) {
    control.cancelled.store(true, Ordering::SeqCst);
}

fn github_url(full_name: &str) -> Result<String, String> {
    let parts: Vec<_> = full_name.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|p| {
            p.is_empty()
                || *p == "."
                || *p == ".."
                || !p
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
    {
        return Err("Choose a GitHub repository in owner/name form".into());
    }
    Ok(format!("https://github.com/{full_name}.git"))
}

// Authentication exists only in the child environment, never in command-line
// arguments, saved remote URLs or Git config. Disable interactive helpers.
fn remote_git(repo: &Path, args: &[&str], token: Option<&str>) -> Result<String, String> {
    let auth = token
        .filter(|t| !t.is_empty())
        .map(|t| STANDARD.encode(format!("x-access-token:{t}")));
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_COUNT", if auth.is_some() { "4" } else { "3" })
        .env("GIT_CONFIG_KEY_0", "credential.helper")
        .env("GIT_CONFIG_VALUE_0", "")
        .env("GIT_CONFIG_KEY_1", "http.followRedirects")
        .env("GIT_CONFIG_VALUE_1", "false")
        .env("GIT_CONFIG_KEY_2", "core.hooksPath")
        .env("GIT_CONFIG_VALUE_2", "/dev/null");
    if let Some(auth) = &auth {
        command
            .env("GIT_CONFIG_KEY_3", "http.https://github.com/.extraheader")
            .env("GIT_CONFIG_VALUE_3", format!("Authorization: Basic {auth}"));
    }
    let output = command
        .output()
        .map_err(|e| format!("Could not run Git: {e}"))?;
    if !output.status.success() {
        let mut message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        if let Some(auth) = auth {
            message = message.replace(&auth, "[redacted]");
        }
        if let Some(token) = token.filter(|t| !t.is_empty()) {
            message = message.replace(token, "[redacted]");
        }
        return Err(format!("Could not download repository: {message}"));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn prepare_github(
    cache: &Path,
    full_name: &str,
    token: Option<&str>,
    cancelled: &AtomicBool,
    progress: impl Fn(&str),
) -> Result<PathBuf, String> {
    let url = github_url(full_name)?;
    prepare_cache(cache, full_name, &url, token, cancelled, progress)
}

fn prepare_cache(
    cache: &Path,
    full_name: &str,
    url: &str,
    token: Option<&str>,
    cancelled: &AtomicBool,
    progress: impl Fn(&str),
) -> Result<PathBuf, String> {
    let repo = cache.join(format!("{}.git", full_name.to_lowercase()));
    std::fs::create_dir_all(repo.parent().ok_or("Invalid cache path")?)
        .map_err(|e| e.to_string())?;
    check_cancel(cancelled)?;
    if !repo.exists() {
        progress("Cloning full Git history");
        // A failed clone is never treated as a complete cache on the next run.
        let staging = repo.with_extension("cloning");
        if staging.exists() {
            std::fs::remove_dir_all(&staging).map_err(|e| e.to_string())?;
        }
        let result = remote_git(
            cache,
            &[
                "clone",
                "--bare",
                "--",
                url,
                staging.to_str().ok_or("Invalid cache path")?,
            ],
            token,
        );
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&staging);
        }
        result?;
        std::fs::rename(&staging, &repo).map_err(|e| e.to_string())?;
    } else {
        progress("Updating cached Git history");
        remote_git(
            &repo,
            &[
                "fetch",
                "--force",
                "--prune",
                "--",
                url,
                "+refs/heads/*:refs/heads/*",
                "+refs/tags/*:refs/tags/*",
            ],
            token,
        )?;
    }
    check_cancel(cancelled)?;
    // Refresh the default branch as well; a cached HEAD can otherwise go stale.
    let refs = remote_git(&repo, &["ls-remote", "--symref", "--", url, "HEAD"], token)?;
    if let Some(head) = refs.lines().find_map(|l| {
        l.strip_prefix("ref: ")
            .and_then(|s| s.strip_suffix("\tHEAD"))
    }) {
        git(&repo, &["symbolic-ref", "HEAD", head])?;
    }
    check_cancel(cancelled)?;
    Ok(repo)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn options(repo: &Path) -> ScanOptions {
        ScanOptions {
            repo: repo.to_str().unwrap().into(),
            revision: "HEAD".into(),
            group_by: GroupBy::Person,
            pathspecs: vec![],
            excludes: vec![],
            include_generated: false,
            ignore_whitespace: true,
            exclude_bots: false,
        }
    }
    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-b", "main"]).unwrap();
        git(dir.path(), &["config", "user.name", "Alice Example"]).unwrap();
        git(dir.path(), &["config", "user.email", "alice@example.com"]).unwrap();
        git(dir.path(), &["config", "commit.gpgsign", "false"]).unwrap();
        fs::write(dir.path().join("code.txt"), "one\ntwo\nthree\n").unwrap();
        fs::write(dir.path().join("package-lock.json"), "generated\n").unwrap();
        fs::write(dir.path().join("binary"), b"abc\0def\n").unwrap();
        git(dir.path(), &["add", "."]).unwrap();
        git(dir.path(), &["commit", "-m", "Initial\n\nCo-authored-by: Bob Example <bob@example.com>\nCo-authored-by: Alice Example <alice@work.com>"]).unwrap();
        dir
    }
    #[test]
    fn surviving_lines_coauthors_aliases_filters_and_pinned_revision() {
        let dir = fixture();
        let first = git_text(dir.path(), &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_owned();
        let cancel = AtomicBool::new(false);
        let report = scan(options(dir.path()), &cancel, |_| {}).unwrap();
        assert_eq!(
            (
                report.total_lines,
                report.credited_lines,
                report.coauthored_lines
            ),
            (3, 6, 3)
        );
        assert_eq!(report.authors.len(), 2);
        assert_eq!(report.files_skipped["binary"], 1);
        assert_eq!(report.files_skipped["generated / excluded"], 1);
        assert_eq!(report.authors[0].emails.len(), 2);
        let mut opts = options(dir.path());
        opts.group_by = GroupBy::Email;
        assert_eq!(scan(opts, &cancel, |_| {}).unwrap().credited_lines, 9);
        fs::write(dir.path().join("code.txt"), "changed\ntwo\n").unwrap();
        git(dir.path(), &["add", "."]).unwrap();
        git(
            dir.path(),
            &[
                "commit",
                "--author",
                "Carol <carol@example.com>",
                "-m",
                "Change and delete",
            ],
        )
        .unwrap();
        let report = scan(options(dir.path()), &cancel, |_| {}).unwrap();
        assert_eq!((report.total_lines, report.credited_lines), (2, 3));
        let mut opts = options(dir.path());
        opts.revision = first;
        assert_eq!(scan(opts, &cancel, |_| {}).unwrap().total_lines, 3);
        fs::write(dir.path().join("code.txt"), "uncommitted\n").unwrap();
        assert_eq!(
            scan(options(dir.path()), &cancel, |_| {})
                .unwrap()
                .total_lines,
            2
        );
        let mut opts = options(dir.path());
        opts.pathspecs = vec!["missing/".into()];
        assert_eq!(scan(opts, &cancel, |_| {}).unwrap().total_lines, 0);
        let mut opts = options(dir.path());
        opts.excludes = vec!["code.*".into()];
        assert_eq!(scan(opts, &cancel, |_| {}).unwrap().total_lines, 0);
    }
    #[test]
    fn whitespace_mailmap_bare_repositories_and_errors() {
        let dir = fixture();
        let cancel = AtomicBool::new(false);
        fs::write(dir.path().join("code.txt"), "one  \ntwo\nthree\n").unwrap();
        git(dir.path(), &["add", "."]).unwrap();
        git(
            dir.path(),
            &[
                "commit",
                "--author",
                "Formatter <format@example.com>",
                "-m",
                "Whitespace",
            ],
        )
        .unwrap();
        assert_eq!(
            scan(options(dir.path()), &cancel, |_| {})
                .unwrap()
                .coauthored_lines,
            3
        );
        let mut opts = options(dir.path());
        opts.ignore_whitespace = false;
        assert_eq!(scan(opts, &cancel, |_| {}).unwrap().coauthored_lines, 2);
        fs::write(
            dir.path().join(".mailmap"),
            "Canonical Alice <canonical@example.com> Alice Example <alice@example.com>\n",
        )
        .unwrap();
        assert!(scan(options(dir.path()), &cancel, |_| {})
            .unwrap()
            .authors
            .iter()
            .any(|a| a.author == "Canonical Alice"));
        let dest = tempfile::tempdir().unwrap();
        git(
            dest.path(),
            &["clone", "--bare", dir.path().to_str().unwrap(), "clone.git"],
        )
        .unwrap();
        assert_eq!(
            scan(options(&dest.path().join("clone.git")), &cancel, |_| {})
                .unwrap()
                .total_lines,
            3
        );
        let mut opts = options(dir.path());
        opts.revision = "--help".into();
        assert!(scan(opts, &cancel, |_| {}).is_err());
        assert!(scan(options(dir.path()), &AtomicBool::new(true), |_| {}).is_err());
        git(
            dest.path(),
            &[
                "clone",
                "--depth=1",
                &format!("file://{}", dir.path().display()),
                "shallow",
            ],
        )
        .unwrap();
        assert!(scan(options(&dest.path().join("shallow")), &cancel, |_| {})
            .err()
            .unwrap()
            .contains("shallow"));
    }
    #[test]
    fn transitive_identity_merging_and_bot_denominator() {
        let people = [
            ("Alice", "a@x"),
            ("Alice", "b@x"),
            ("Alias", "b@x"),
            ("Alias", "c@x"),
            ("robot[bot]", "bot@x"),
        ];
        let commits = people
            .iter()
            .enumerate()
            .map(|(i, (name, email))| {
                (
                    i.to_string(),
                    CommitLines {
                        author: Identity {
                            name: name.to_string(),
                            email: email.to_string(),
                        },
                        lines: 1,
                    },
                )
            })
            .collect();
        let (authors, total, _) = aggregate(&commits, &BTreeMap::new(), GroupBy::Person, true);
        assert_eq!(total, 4);
        assert_eq!(authors.len(), 1);
        assert_eq!(authors[0].lines, 4);
        let coauthors = BTreeMap::from([(
            "4".into(),
            vec![Identity {
                name: "Human".into(),
                email: "h@x".into(),
            }],
        )]);
        assert_eq!(aggregate(&commits, &coauthors, GroupBy::Person, true).1, 5);
        assert_eq!(
            aggregate(&commits, &coauthors, GroupBy::Name, false)
                .0
                .len(),
            4
        );
    }
    #[test]
    fn managed_clone_refreshes_history_and_default_branch_without_saving_credentials() {
        let origin = fixture();
        let cache = tempfile::tempdir().unwrap();
        let cancel = AtomicBool::new(false);
        let url = origin.path().to_str().unwrap();
        let path = prepare_cache(
            cache.path(),
            "org/repo.name",
            url,
            Some("test-token"),
            &cancel,
            |_| {},
        )
        .unwrap();
        assert_eq!(path, cache.path().join("org/repo.name.git"));
        assert_eq!(
            scan(options(&path), &cancel, |_| {}).unwrap().total_lines,
            3
        );
        let config = fs::read_to_string(path.join("config")).unwrap();
        assert!(!config.contains("test-token"));
        assert!(!config.contains("Authorization"));
        git(origin.path(), &["checkout", "-b", "new-default"]).unwrap();
        fs::write(origin.path().join("code.txt"), "new line\n").unwrap();
        git(origin.path(), &["add", "."]).unwrap();
        git(origin.path(), &["commit", "-m", "New branch"]).unwrap();
        prepare_cache(cache.path(), "org/repo.name", url, None, &cancel, |_| {}).unwrap();
        assert_eq!(
            git_text(&path, &["symbolic-ref", "HEAD"]).unwrap().trim(),
            "refs/heads/new-default"
        );
        assert_eq!(
            scan(options(&path), &cancel, |_| {}).unwrap().total_lines,
            1
        );
        assert!(prepare_cache(
            cache.path(),
            "org/missing",
            "/missing/origin",
            None,
            &cancel,
            |_| {}
        )
        .is_err());
        assert!(!cache.path().join("org/missing.git").exists());
        assert!(!cache.path().join("org/missing.cloning").exists());
    }
    #[test]
    fn github_names_cannot_escape_cache_or_change_host() {
        for bad in [
            "../repo",
            "owner/..",
            "owner/repo/other",
            "owner/repo?token=x",
            "https://elsewhere",
            "owner/-x;touch x",
        ] {
            assert!(github_url(bad).is_err(), "{bad}");
        }
        assert_eq!(
            github_url("org/repo.name").unwrap(),
            "https://github.com/org/repo.name.git"
        );
    }
}
