//! Surviving-line attribution from a pinned local Git revision.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{ipc::Channel, Manager, State};
mod history;
mod process;

type ActiveJobs = Arc<Mutex<BTreeMap<String, (String, Arc<AtomicBool>)>>>;

pub struct ScanControl {
    active: ActiveJobs,
    calculation: Arc<Permits>,
    /// History walks kept in memory between batches, keyed by repository. A batch
    /// reuses one only when the caller names the checkpoint it came from.
    jobs: Arc<Mutex<BTreeMap<String, history::Job>>>,
}

impl Default for ScanControl {
    fn default() -> Self {
        let permits = std::env::var("GITHUB_MONITOR_OWNERSHIP_PERMITS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(2usize)
            .clamp(1, 8);
        ScanControl {
            active: ActiveJobs::default(),
            calculation: Arc::new(Permits::new(permits)),
            jobs: Arc::default(),
        }
    }
}

/// A counting semaphore for repository calculations. Blame workers are divided
/// between permits, so total Git processes stay near the machine's worker count
/// however many repositories calculate at once.
pub struct Permits {
    max: usize,
    active: Mutex<usize>,
    freed: std::sync::Condvar,
}

pub struct Permit<'a> {
    permits: &'a Permits,
}

impl Permits {
    fn new(max: usize) -> Self {
        Permits {
            max,
            active: Mutex::new(0),
            freed: std::sync::Condvar::new(),
        }
    }

    /// Wait for a slot, giving up promptly when this job is cancelled.
    fn acquire(&self, cancelled: &AtomicBool) -> Result<Permit<'_>, String> {
        let mut active = self.active.lock().unwrap_or_else(|p| p.into_inner());
        loop {
            check_cancel(cancelled)?;
            if *active < self.max {
                *active += 1;
                return Ok(Permit { permits: self });
            }
            active = self
                .freed
                .wait_timeout(active, Duration::from_millis(50))
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
    }

    fn workers(&self) -> usize {
        (worker_count() / self.max).max(1)
    }
}

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        let mut active = self.permits.active.lock().unwrap_or_else(|p| p.into_inner());
        *active = active.saturating_sub(1);
        self.permits.freed.notify_one();
    }
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
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

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq)]
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorRow {
    author: String,
    names: Vec<String>,
    emails: Vec<String>,
    lines: u64,
    share: f64,
}

#[derive(Clone, Deserialize, Serialize)]
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
    credits: Vec<LineCredit>,
    files_reused: usize,
    files_recalculated: usize,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, Eq, PartialEq, Ord, PartialOrd, Hash)]
struct Identity {
    name: String,
    email: String,
}
#[derive(Clone, Default, Deserialize, Serialize)]
struct CommitLines {
    author: Identity,
    lines: u64,
}

#[derive(Clone, Deserialize, Serialize)]
struct LineCredit {
    lines: u64,
    people: Vec<Identity>,
}

#[derive(Clone, Deserialize, Serialize)]
struct CachedFile {
    blob: String,
    binary: bool,
    counts: BTreeMap<String, CommitLines>,
}

// Stored with the report in a single SQLite row: the file cache and commit
// checkpoint become visible atomically, even if a sync is interrupted.
#[derive(Clone, Deserialize, Serialize)]
struct Snapshot {
    version: u32,
    report: Report,
    files: BTreeMap<String, CachedFile>,
    coauthors: BTreeMap<String, Vec<Identity>>,
}
const SNAPSHOT_VERSION: u32 = 2;

#[cfg(test)]
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

#[cfg(test)]
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

/// One GitHub account, in whichever noreply spelling a commit used.
///
/// `login@users.noreply.github.com` and `id+login@users.noreply.github.com` are
/// the same account. The numeric id is what stays put when the login is renamed.
fn github_account(email: &str) -> Option<(Option<String>, String)> {
    let email = email.trim().to_lowercase();
    let (local, host) = email.rsplit_once('@')?;
    if host != "users.noreply.github.com" || local.is_empty() {
        return None;
    }
    match local.split_once('+') {
        Some((id, login))
            if !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()) && !login.is_empty() =>
        {
            Some((Some(id.to_owned()), login.to_owned()))
        }
        _ => Some((None, local.to_owned())),
    }
}
fn is_bot(p: &Identity) -> bool {
    let text = format!("{} {}", p.name, p.email).to_lowercase();
    text.contains("[bot]") || text.contains("copilot")
}

#[cfg(test)]
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

fn parse_incremental_reader(
    reader: &mut impl BufRead,
) -> Result<BTreeMap<String, CommitLines>, String> {
    let mut commits = BTreeMap::<String, CommitLines>::new();
    let mut sha = String::new();
    let mut bytes = Vec::new();
    loop {
        bytes.clear();
        if reader
            .read_until(b'\n', &mut bytes)
            .map_err(|e| e.to_string())?
            == 0
        {
            break;
        }
        let line = String::from_utf8_lossy(&bytes);
        let line = line.trim_end_matches(['\r', '\n']);
        let mut fields = line.split_whitespace();
        if let Some(token) = fields.next() {
            if is_commit_id(token) {
                sha = token.to_owned();
                let count = fields
                    .nth(2)
                    .ok_or("Missing blame group size")?
                    .parse::<u64>()
                    .map_err(|_| "Invalid blame group size")?;
                commits.entry(sha.to_owned()).or_default().lines += count;
                continue;
            }
        }
        if sha.is_empty() {
            continue;
        }
        if let Some(name) = line.strip_prefix("author ") {
            commits.entry(sha.to_owned()).or_default().author.name = name.to_owned();
        } else if let Some(email) = line.strip_prefix("author-mail ") {
            commits.entry(sha.to_owned()).or_default().author.email = email
                .trim()
                .trim_start_matches('<')
                .trim_end_matches('>')
                .to_lowercase();
        }
    }
    Ok(commits)
}

fn git_command(repo: &Path, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0");
    command
}
fn git_cancel(repo: &Path, args: &[&str], cancelled: &AtomicBool) -> Result<Vec<u8>, String> {
    process::output(git_command(repo, args), cancelled)
}

/// One process reads all changed blobs. Only the binary-detection prefix is
/// retained; large blobs are drained through a bounded buffer.
fn binary_blobs(repo: &Path, blobs: &[&str], cancelled: &AtomicBool) -> Result<Vec<bool>, String> {
    if blobs.is_empty() {
        return Ok(Vec::new());
    }
    let input = blobs
        .iter()
        .map(|sha| format!("{sha}\n"))
        .collect::<String>();
    process::stream(
        git_command(repo, &["cat-file", "--batch"]),
        input.as_bytes(),
        cancelled,
        |reader| {
            let mut result = Vec::with_capacity(blobs.len());
            let mut prefix = [0u8; 8000];
            for expected in blobs {
                check_cancel(cancelled)?;
                let mut header = String::new();
                reader.read_line(&mut header).map_err(|e| e.to_string())?;
                let fields: Vec<_> = header.split_whitespace().collect();
                if fields.len() != 3 || fields[0] != *expected || fields[1] != "blob" {
                    return Err("Invalid blob batch response".into());
                }
                let size = fields[2].parse::<u64>().map_err(|_| "Invalid blob size")?;
                let count = size.min(prefix.len() as u64) as usize;
                reader
                    .read_exact(&mut prefix[..count])
                    .map_err(|e| e.to_string())?;
                result.push(prefix[..count].contains(&0));
                let remaining = size - count as u64;
                let drained =
                    std::io::copy(&mut reader.by_ref().take(remaining), &mut std::io::sink())
                        .map_err(|e| e.to_string())?;
                if drained != remaining {
                    return Err("Truncated blob batch response".into());
                }
                let mut end = [0];
                reader.read_exact(&mut end).map_err(|e| e.to_string())?;
                if end[0] != b'\n' {
                    return Err("Invalid blob batch delimiter".into());
                }
            }
            Ok(result)
        },
    )
}

fn worker_count() -> usize {
    std::thread::available_parallelism().map_or(1, |n| n.get().min(4))
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

/// Author, committer and trailer identities from every reachable commit.
///
/// Blame only sees lines that still exist. An older commit can be the only place
/// a name and an email occur together, and that pair is what joins the two.
/// A commit's author and committer are recorded separately: on a merge or rebase
/// they are often different people.
fn history_aliases(
    repo: &Path,
    revision: &str,
    cancelled: &AtomicBool,
) -> Result<Vec<Identity>, String> {
    let with_trailers = git_text_cancel(
        repo,
        &[
            "log",
            "--format=%x1e%aN%x1f%aE%x1f%cN%x1f%cE%x1f%(trailers:only,unfold)",
            "--end-of-options",
            revision,
        ],
        cancelled,
    );
    let log = match with_trailers {
        Ok(log) => log,
        Err(error) => {
            check_cancel(cancelled)?;
            git_text_cancel(
                repo,
                &[
                    "log",
                    "--format=%x1e%aN%x1f%aE%x1f%cN%x1f%cE",
                    "--end-of-options",
                    revision,
                ],
                cancelled,
            )
            .map_err(|_| error)?
        }
    };
    let mut seen = BTreeSet::new();
    let mut aliases = Vec::new();
    let mut push = |name: &str, email: &str| {
        let name = name.trim();
        let email = email
            .trim()
            .trim_start_matches('<')
            .trim_end_matches('>')
            .to_lowercase();
        if name.is_empty() && email.is_empty() {
            return;
        }
        if seen.insert((name.to_owned(), email.clone())) {
            aliases.push(Identity {
                name: name.to_owned(),
                email,
            });
        }
    };
    for record in log.split('\u{1e}') {
        if record.trim().is_empty() {
            continue;
        }
        let mut parts = record.splitn(5, '\u{1f}');
        let author_name = parts.next().unwrap_or("");
        let author_email = parts.next().unwrap_or("");
        let committer_name = parts.next().unwrap_or("");
        let committer_email = parts.next().unwrap_or("");
        let trailers = parts.next().unwrap_or("");
        push(author_name, author_email);
        push(committer_name, committer_email);
        for line in trailers.lines() {
            let Some((_, rest)) = line.split_once(':') else {
                continue;
            };
            let Some((name, email)) = rest.trim().rsplit_once('<') else {
                continue;
            };
            push(name, email);
        }
    }
    Ok(aliases)
}

fn aggregate(
    commits: &BTreeMap<String, CommitLines>,
    coauthors: &BTreeMap<String, Vec<Identity>>,
    aliases: &[Identity],
    group: GroupBy,
    exclude_bots: bool,
) -> (Vec<AuthorRow>, u64, u64) {
    let identities: Vec<_> = commits
        .values()
        .map(|c| &c.author)
        .chain(coauthors.values().flatten())
        .chain(aliases)
        .collect();
    let mut parents = BTreeMap::new();
    let mut by_name = BTreeMap::<String, String>::new();
    let mut by_login = BTreeMap::<String, String>::new();
    let mut by_github_id = BTreeMap::<String, String>::new();
    let link = |parents: &mut BTreeMap<String, String>,
                index: &mut BTreeMap<String, String>,
                token: String,
                key: &str| {
        if token.is_empty() {
            return;
        }
        if let Some(other) = index.get(&token) {
            let left = root(parents, other);
            let right = root(parents, key);
            parents.insert(right, left);
        } else {
            index.insert(token, key.to_owned());
        }
    };
    for person in identities {
        let key = identity_key(person);
        parents.entry(key.clone()).or_insert(key.clone());
        link(&mut parents, &mut by_name, normalize(&person.name), &key);
        if let Some((id, login)) = github_account(&person.email) {
            link(&mut parents, &mut by_login, login, &key);
            if let Some(id) = id {
                link(&mut parents, &mut by_github_id, id, &key);
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
    // Historical aliases name the person but do not own the surviving lines.
    if matches!(group, GroupBy::Person) {
        for person in aliases {
            let Some(credit) = credits.get_mut(&root(&parents, &identity_key(person))) else {
                continue;
            };
            if !person.name.is_empty() {
                credit.names.entry(person.name.clone()).or_default();
            }
            if !person.email.is_empty() {
                credit.emails.entry(person.email.clone()).or_default();
            }
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
                GroupBy::Person => emails
                    .iter()
                    .find_map(|email| github_account(email).map(|(_, login)| login))
                    .or_else(|| names.iter().find(|n| n.trim().contains(' ')).cloned())
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

fn is_commit_id(value: &str) -> bool {
    (value.len() == 40 || value.len() == 64) && value.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
fn scan(
    options: ScanOptions,
    cancelled: &AtomicBool,
    progress: impl Fn(Progress),
) -> Result<Report, String> {
    scan_snapshot(options, None, cancelled, progress).map(|s| s.report)
}

#[cfg(test)]
fn scan_snapshot(
    options: ScanOptions,
    previous: Option<&Snapshot>,
    cancelled: &AtomicBool,
    progress: impl Fn(Progress),
) -> Result<Snapshot, String> {
    scan_snapshot_at(
        options,
        previous,
        cancelled,
        progress,
        None,
        worker_count(),
        false,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn scan_snapshot_at(
    options: ScanOptions,
    previous: Option<&Snapshot>,
    cancelled: &AtomicBool,
    progress: impl Fn(Progress),
    pinned: Option<&str>,
    workers: usize,
    adjacent: bool,
    known_aliases: Option<&[Identity]>,
) -> Result<Snapshot, String> {
    let git = |repo: &Path, args: &[&str]| git_cancel(repo, args, cancelled);
    let git_text = |repo: &Path, args: &[&str]| {
        git(repo, args).map(|b| String::from_utf8_lossy(&b).into_owned())
    };
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
    let rev = if let Some(pinned) = pinned {
        pinned
    } else if options.revision.trim().is_empty() {
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
    let owned_aliases;
    let aliases: &[Identity] = if let Some(aliases) = known_aliases {
        aliases
    } else {
        owned_aliases = history_aliases(&repo, &revision, cancelled)?;
        &owned_aliases
    };
    let mut changed = BTreeSet::new();
    let previous = previous.filter(|p| {
        p.version == SNAPSHOT_VERSION
            && p.report.options == options
            && git(
                &repo,
                &["merge-base", "--is-ancestor", &p.report.revision, &revision],
            )
            .is_ok()
    });
    if let Some(previous) = previous {
        if previous.report.revision != revision {
            let diff = if adjacent {
                // The history walk steps one first-parent commit. A restore then
                // has a different blob from its parent, so the tree diff is enough.
                let parent = git_text(
                    &repo,
                    &[
                        "rev-parse",
                        "--verify",
                        "--end-of-options",
                        &format!("{revision}^"),
                    ],
                )?;
                if parent.trim() != previous.report.revision {
                    return Err("Ownership history can only reuse the parent commit".into());
                }
                git(
                    &repo,
                    &[
                        "diff-tree",
                        "--no-commit-id",
                        "-r",
                        "-z",
                        "--name-only",
                        &previous.report.revision,
                        &revision,
                    ],
                )?
            } else {
                // Include all paths touched in intervening commits, including merges
                // and changes later reverted to the same blob. Tree diff alone is unsafe.
                let range = format!("{}..{}", previous.report.revision, revision);
                git(
                    &repo,
                    &[
                        "log",
                        "--format=",
                        "--name-only",
                        "-z",
                        "--full-history",
                        "-m",
                        &range,
                        "--",
                    ],
                )?
            };
            for path in diff.split(|b| *b == 0).filter(|p| !p.is_empty()) {
                changed.insert(
                    std::str::from_utf8(path)
                        .map_err(|_| "Non-UTF-8 changed path")?
                        .to_owned(),
                );
            }
        }
    }
    // Mailmap changes can change identities in every otherwise untouched file.
    let previous = previous.filter(|_| !changed.contains(".mailmap"));
    let patterns: Vec<glob::Pattern> = GENERATED
        .iter()
        .filter(|_| !options.include_generated)
        .copied()
        .chain(options.excludes.iter().map(String::as_str))
        .map(|p| glob::Pattern::new(p).map_err(|e| format!("Invalid exclude pattern {p}: {e}")))
        .collect::<Result<_, _>>()?;
    let mut args = vec!["ls-tree", "-r", "-l", "-z", &revision, "--"];
    args.extend(options.pathspecs.iter().map(String::as_str));
    let tree = git(&repo, &args)?;
    let mut files = Vec::new();
    let mut file_sizes = BTreeMap::new();
    let mut skipped = BTreeMap::<String, usize>::new();
    for entry in tree.split(|b| *b == 0).filter(|e| !e.is_empty()) {
        let entry = std::str::from_utf8(entry)
            .map_err(|_| "A tracked filename is not valid UTF-8; cannot scan it accurately.")?;
        let (meta, path) = entry.split_once('\t').ok_or("Invalid Git tree entry")?;
        let parts: Vec<_> = meta.split_whitespace().collect();
        if parts.len() != 4 {
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
            file_sizes.insert(
                path.to_owned(),
                parts[3].parse::<u64>().map_err(|_| "Invalid blob size")?,
            );
            files.push((path.to_owned(), parts[2].to_owned()));
        }
    }
    let total = files.len();
    let mut commits: BTreeMap<String, CommitLines> = BTreeMap::new();
    let mut cached_files = BTreeMap::new();
    let mut files_blamed = 0;
    let mut files_reused = 0;
    let mut files_recalculated = 0;
    progress(Progress {
        completed: 0,
        total,
        phase: "Updating line ownership".into(),
    });
    let mut jobs = Vec::new();
    for (path, blob) in &files {
        if let Some(cached) = previous
            .and_then(|p| p.files.get(path))
            .filter(|f| f.blob == *blob && !changed.contains(path))
        {
            files_reused += 1;
            cached_files.insert(path.clone(), cached.clone());
        } else {
            jobs.push((path.clone(), blob.clone()));
        }
    }
    // Start large files early so they do not become a serial tail at the end.
    jobs.sort_by(|a, b| file_sizes[&b.0].cmp(&file_sizes[&a.0]).then(a.0.cmp(&b.0)));
    let blobs: Vec<_> = jobs
        .iter()
        .map(|(_, blob)| blob.as_str())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let flags = binary_blobs(&repo, &blobs, cancelled)?;
    let flags: BTreeMap<_, _> = blobs.into_iter().zip(flags).collect();
    let binary: Vec<_> = jobs.iter().map(|(_, blob)| flags[blob.as_str()]).collect();
    let next = AtomicUsize::new(0);
    let stop = AtomicBool::new(false);
    // Bound queued results; workers cannot materialize an entire scan ahead of aggregation.
    let (sender, receiver) = std::sync::mpsc::sync_channel(workers.max(1));
    let mut last_progress = Instant::now();
    let result = std::thread::scope(|scope| -> Result<(), String> {
        for _ in 0..workers.max(1).min(jobs.len()) {
            let sender = sender.clone();
            let (jobs, binary, next, stop, repo, revision, options) =
                (&jobs, &binary, &next, &stop, &repo, &revision, &options);
            scope.spawn(move || {
                while !stop.load(Ordering::Relaxed) && !cancelled.load(Ordering::Relaxed) {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some((path, blob)) = jobs.get(index) else {
                        break;
                    };
                    let result = (|| {
                        let counts = if binary[index] {
                            BTreeMap::new()
                        } else {
                            let mut args: Vec<&str> = history::DIFF_CONFIG.to_vec();
                            args.extend(["blame", "--incremental", "--encoding=utf-8"]);
                            if options.ignore_whitespace {
                                args.push("-w");
                            }
                            args.extend([revision, "--", path]);
                            process::stream(git_command(repo, &args), &[], cancelled, |reader| {
                                parse_incremental_reader(reader)
                            })
                            .map_err(|e| format!("Cannot blame {path}: {e}"))?
                        };
                        Ok(CachedFile {
                            blob: blob.clone(),
                            binary: binary[index],
                            counts,
                        })
                    })();
                    if result.is_err() {
                        stop.store(true, Ordering::Relaxed);
                    }
                    if sender.send((path.clone(), result)).is_err() {
                        break;
                    }
                }
            });
        }
        drop(sender);
        let mut failure = None;
        for (path, result) in receiver {
            match result {
                Ok(file) => {
                    cached_files.insert(path, file);
                    files_recalculated += 1;
                }
                Err(error) => {
                    failure.get_or_insert(error);
                }
            }
            if last_progress.elapsed() >= Duration::from_millis(150) {
                progress(Progress {
                    completed: files_reused + files_recalculated,
                    total,
                    phase: format!(
                        "Line ownership: {files_recalculated} recalculated, {files_reused} reused"
                    ),
                });
                last_progress = Instant::now();
            }
        }
        if let Some(error) = failure {
            return Err(error);
        }
        check_cancel(cancelled)?;
        Ok(())
    });
    result?;
    // Sorted aggregation is deterministic regardless of worker completion order.
    for file in cached_files.values() {
        if file.binary {
            *skipped.entry("binary".into()).or_default() += 1;
        } else {
            files_blamed += 1;
            for (sha, count) in &file.counts {
                let entry = commits.entry(sha.clone()).or_default();
                entry.author = count.author.clone();
                entry.lines += count.lines;
            }
        }
    }
    check_cancel(cancelled)?;
    progress(Progress {
        completed: total,
        total,
        phase: "Reading co-authors".into(),
    });
    let mut coauthors: BTreeMap<_, _> = previous
        .map(|p| {
            p.coauthors
                .iter()
                .filter(|(sha, _)| commits.contains_key(*sha))
                .map(|(sha, people)| (sha.clone(), people.clone()))
                .collect()
        })
        .unwrap_or_default();
    let shas: Vec<_> = commits
        .keys()
        .filter(|sha| !coauthors.contains_key(*sha))
        .map(String::as_str)
        .collect();
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
    let (authors, total_lines, coauthored_lines) = aggregate(
        &commits,
        &coauthors,
        aliases,
        options.group_by,
        options.exclude_bots,
    );
    // One credit per distinct list of people. Aggregation sums lines per credit,
    // so merging identical lists keeps every total and makes the report small.
    let mut grouped = BTreeMap::<Vec<Identity>, u64>::new();
    for (sha, count) in &commits {
        let people: Vec<Identity> = std::iter::once(count.author.clone())
            .chain(coauthors.get(sha).into_iter().flatten().cloned())
            .collect();
        *grouped.entry(people).or_default() += count.lines;
    }
    let credits = grouped
        .into_iter()
        .map(|(people, lines)| LineCredit { lines, people })
        .collect();
    let report = Report {
        repo: repo.to_string_lossy().into_owned(),
        revision,
        options,
        files_blamed,
        files_skipped: skipped,
        total_lines,
        credited_lines: authors.iter().map(|a| a.lines).sum(),
        coauthored_lines,
        authors,
        credits,
        files_reused,
        files_recalculated,
    };
    Ok(Snapshot {
        version: SNAPSHOT_VERSION,
        report,
        files: cached_files,
        coauthors,
    })
}

fn git_text_cancel(repo: &Path, args: &[&str], cancelled: &AtomicBool) -> Result<String, String> {
    git_cancel(repo, args, cancelled).map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

struct ActiveScan {
    active: ActiveJobs,
    repository: String,
    cancelled: Arc<AtomicBool>,
}
fn lock_map(
    active: &ActiveJobs,
) -> std::sync::MutexGuard<'_, BTreeMap<String, (String, Arc<AtomicBool>)>> {
    match active.lock() {
        Ok(guard) => guard,
        // A panicked scan must not wedge every later repository.
        Err(poisoned) => poisoned.into_inner(),
    }
}
impl Drop for ActiveScan {
    fn drop(&mut self) {
        lock_map(&self.active).remove(&self.repository);
    }
}
impl ScanControl {
    fn cancel(&self, job_id: &str) {
        for (id, cancelled) in lock_map(&self.active).values() {
            if id == job_id {
                cancelled.store(true, Ordering::SeqCst);
            }
        }
    }
    fn begin(&self, repository: &str, job_id: &str) -> Result<ActiveScan, String> {
        github_url(repository)?;
        let repository = repository.to_lowercase();
        let mut active = lock_map(&self.active);
        if active.contains_key(&repository) {
            return Err("This repository is already syncing".into());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        active.insert(repository.clone(), (job_id.into(), cancelled.clone()));
        Ok(ActiveScan {
            active: self.active.clone(),
            repository,
            cancelled,
        })
    }
}

#[derive(Deserialize)]
pub struct CheckpointMetadata {
    version: u32,
    revision: String,
    options: ScanOptions,
}
#[derive(Serialize)]
pub struct PreparedOwnership {
    revision: String,
    unchanged: bool,
}
fn managed_options(repo: &Path) -> ScanOptions {
    ScanOptions {
        repo: repo.to_string_lossy().into_owned(),
        revision: "HEAD".into(),
        group_by: GroupBy::Person,
        pathspecs: vec![],
        excludes: vec![],
        include_generated: false,
        ignore_whitespace: true,
        exclude_bots: false,
    }
}
fn matches_checkpoint(metadata: Option<&CheckpointMetadata>, repo: &Path, revision: &str) -> bool {
    metadata.is_some_and(|m| {
        m.version == SNAPSHOT_VERSION
            && m.revision == revision
            && m.options == managed_options(repo)
    })
}
fn head_revision(repo: &Path, cancelled: &AtomicBool) -> Result<String, String> {
    match git_cancel(repo, &["rev-parse", "--verify", "HEAD^{commit}"], cancelled) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).trim().to_owned()),
        Err(error) => {
            check_cancel(cancelled)?;
            let refs = git_cancel(
                repo,
                &["for-each-ref", "--count=1", "--format=%(objectname)"],
                cancelled,
            )?;
            if refs.is_empty() {
                Ok(String::new())
            } else {
                Err(error)
            }
        }
    }
}
#[tauri::command]
pub async fn prepare_line_ownership(
    github_repo: String,
    job_id: String,
    token: String,
    metadata: Option<serde_json::Value>,
    app: tauri::AppHandle,
    on_progress: Channel<Progress>,
    control: State<'_, ScanControl>,
) -> Result<PreparedOwnership, String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("line-ownership");
    let active = control.begin(&github_repo, &job_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let phase = |message: &str| {
            let _ = on_progress.send(Progress {
                completed: 0,
                total: 0,
                phase: message.into(),
            });
        };
        phase("Checking default branch");
        let repo = prepare_github(&cache, &github_repo, Some(&token), &active.cancelled, phase)?;
        let revision = head_revision(&repo, &active.cancelled)?;
        let metadata: Option<CheckpointMetadata> =
            metadata.and_then(|value| serde_json::from_value(value).ok());
        check_cancel(&active.cancelled)?;
        Ok(PreparedOwnership {
            unchanged: matches_checkpoint(metadata.as_ref(), &repo, &revision),
            revision,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The HEAD scan's result: the small report the page reads, the metadata an
/// unchanged check compares, and the name of the native per-file cache.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnershipScan {
    report: String,
    metadata: String,
    cache_ref: String,
}

fn heads_dir(cache: &Path, github_repo: &str) -> PathBuf {
    cache
        .join("heads")
        .join(github_repo.to_lowercase().replace('/', "__"))
}

fn valid_cache_ref(name: &str) -> bool {
    !name.is_empty()
        && name.len() < 200
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}

/// Write a HEAD file cache under a new name: temporary file, flush, rename. The
/// previous file stays until the database row points past it.
fn write_head_cache(dir: &Path, snapshot: &Snapshot) -> Result<String, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let revision = &snapshot.report.revision;
    let name = format!(
        "v{}-{}-{nanos}.json",
        snapshot.version,
        if revision.is_empty() { "empty" } else { &revision[..revision.len().min(12)] }
    );
    let temp = dir.join(format!(".{name}.tmp"));
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&temp).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec(snapshot).map_err(|e| e.to_string())?)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
    }
    std::fs::rename(&temp, dir.join(&name)).map_err(|e| e.to_string())?;
    Ok(name)
}

fn read_head_cache(dir: &Path, name: &str) -> Option<Snapshot> {
    if !valid_cache_ref(name) {
        return None;
    }
    let bytes = std::fs::read(dir.join(name)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn scan_result(snapshot: &Snapshot, cache_ref: String) -> Result<OwnershipScan, String> {
    Ok(OwnershipScan {
        report: serde_json::to_string(&snapshot.report).map_err(|e| e.to_string())?,
        metadata: serde_json::to_string(&serde_json::json!({
            "version": snapshot.version,
            "revision": snapshot.report.revision,
            "options": snapshot.report.options,
        }))
        .map_err(|e| e.to_string())?,
        cache_ref,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sync_line_ownership(
    github_repo: String,
    job_id: String,
    revision: String,
    previous_ref: Option<String>,
    previous_json: Option<String>,
    app: tauri::AppHandle,
    on_progress: Channel<Progress>,
    control: State<'_, ScanControl>,
) -> Result<OwnershipScan, String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("line-ownership");
    let active = control.begin(&github_repo, &job_id)?;
    let calculation = control.calculation.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let phase = |message: &str| {
            let _ = on_progress.send(Progress {
                completed: 0,
                total: 0,
                phase: message.into(),
            });
        };
        phase("Waiting for calculation workers");
        let _permit = calculation.acquire(&active.cancelled)?;
        let repo = cache.join(format!("{}.git", github_repo.to_lowercase()));
        let heads = heads_dir(&cache, &github_repo);
        let options = managed_options(&repo);
        // A native cache file first; a legacy full JSON snapshot converts once.
        let previous: Option<Snapshot> = previous_ref
            .as_deref()
            .and_then(|name| read_head_cache(&heads, name))
            .or_else(|| previous_json.and_then(|s| serde_json::from_str(&s).ok()));
        if !revision.is_empty() {
            if !is_commit_id(&revision) {
                return Err("Invalid prepared revision".into());
            }
            update_commit_graph(&repo, &revision, &active.cancelled, phase)?;
        }
        let mut snapshot = if revision.is_empty() {
            Snapshot {
                version: SNAPSHOT_VERSION,
                files: BTreeMap::new(),
                coauthors: BTreeMap::new(),
                report: Report {
                    repo: String::new(),
                    revision,
                    options,
                    files_blamed: 0,
                    files_skipped: BTreeMap::new(),
                    total_lines: 0,
                    credited_lines: 0,
                    coauthored_lines: 0,
                    authors: vec![],
                    credits: vec![],
                    files_reused: 0,
                    files_recalculated: 0,
                },
            }
        } else {
            scan_snapshot_at(
                options,
                previous.as_ref(),
                &active.cancelled,
                |event| {
                    let _ = on_progress.send(event);
                },
                Some(&revision),
                calculation.workers(),
                false,
                None,
            )?
        };
        check_cancel(&active.cancelled)?;
        snapshot.report.repo = format!("https://github.com/{github_repo}");
        let name = write_head_cache(&heads, &snapshot)?;
        // Anything but the row's current file and this new one is an orphan.
        let keep: Vec<&str> = previous_ref.iter().map(String::as_str).chain([name.as_str()]).collect();
        history::prune_checkpoints(&heads, &keep);
        scan_result(&snapshot, name)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn advance_line_ownership_history(
    github_repo: String,
    job_id: String,
    revision: String,
    generation: i64,
    checkpoint_ref: Option<String>,
    engine: String,
    app: tauri::AppHandle,
    on_progress: Channel<Progress>,
    control: State<'_, ScanControl>,
) -> Result<history::HistoryBatchV2, String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("line-ownership");
    let active = control.begin(&github_repo, &job_id)?;
    let calculation = control.calculation.clone();
    let jobs = control.jobs.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = calculation.acquire(&active.cancelled)?;
        let repo = cache.join(format!("{}.git", github_repo.to_lowercase()));
        let dir = history::checkpoint_dir(&cache, &github_repo);
        let key = github_repo.to_lowercase();
        let remembered = lock_jobs(&jobs).remove(&key);
        let result = advance_history_job(
            &repo,
            &dir,
            &revision,
            generation,
            checkpoint_ref.as_deref(),
            history::Engine::parse(&engine)?,
            remembered,
            &history::BatchLimits {
                workers: calculation.workers(),
                ..Default::default()
            },
            &active.cancelled,
            |completed, total| {
                let _ = on_progress.send(Progress {
                    completed,
                    total,
                    phase: format!("Ownership history {completed}/{total}"),
                });
            },
        )?;
        let (batch, job) = result;
        if let Some(job) = job {
            lock_jobs(&jobs).insert(key, job);
        }
        Ok(batch)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn lock_jobs(
    jobs: &Mutex<BTreeMap<String, history::Job>>,
) -> std::sync::MutexGuard<'_, BTreeMap<String, history::Job>> {
    jobs.lock().unwrap_or_else(|p| p.into_inner())
}

/// One history batch: continue from the named checkpoint (in memory when it is
/// the one this process just wrote, otherwise from disk), advance, and write the
/// next checkpoint. The job is returned for reuse unless the walk is done.
#[allow(clippy::too_many_arguments)]
fn advance_history_job(
    repo: &Path,
    dir: &Path,
    target: &str,
    generation: i64,
    checkpoint_ref: Option<&str>,
    engine: history::Engine,
    remembered: Option<history::Job>,
    limits: &history::BatchLimits,
    cancelled: &AtomicBool,
    progress: impl Fn(usize, usize),
) -> Result<(history::HistoryBatchV2, Option<history::Job>), String> {
    if target.is_empty() {
        history::prune_checkpoints(dir, &[]);
        return Ok((
            history::HistoryBatchV2 {
                done: true,
                engine: Some(engine),
                final_state: Some(history::FinalState {
                    total_lines: 0,
                    groups: vec![],
                }),
                ..Default::default()
            },
            None,
        ));
    }
    if !is_commit_id(target) {
        return Err("Invalid prepared revision".into());
    }
    let options = managed_options(repo);
    history::prune_checkpoints(dir, &checkpoint_ref.into_iter().collect::<Vec<_>>());
    let reusable = remembered.filter(|job| {
        checkpoint_ref.is_some()
            && job.checkpoint_ref.as_deref() == checkpoint_ref
            && job.state.target == target
            && job.state.generation == generation
            && job.state.engine == engine
    });
    let mut job = match reusable {
        Some(job) => job,
        None => {
            let previous = match checkpoint_ref {
                Some(name) => match history::read_checkpoint(dir, name) {
                    Ok(state) => Some(state),
                    // A missing or corrupt checkpoint restarts in a new generation;
                    // the visible history stays until that one completes.
                    Err(_) => return Ok((reset_batch(engine), None)),
                },
                None => None,
            };
            match history::prepare_job(repo, &options, target, engine, generation, previous, cancelled)? {
                Some(job) => job,
                None => return Ok((reset_batch(engine), None)),
            }
        }
    };
    let mut batch = history::run_batch(&mut job, repo, &options, limits, cancelled, progress)?;
    check_cancel(cancelled)?;
    let name = history::write_checkpoint(dir, &job.state)?;
    job.checkpoint_ref = Some(name.clone());
    batch.checkpoint_ref = Some(name);
    let keep = !batch.done;
    Ok((batch, keep.then_some(job)))
}

fn reset_batch(engine: history::Engine) -> history::HistoryBatchV2 {
    history::HistoryBatchV2 {
        needs_reset: true,
        engine: Some(engine),
        ..Default::default()
    }
}

fn update_commit_graph(
    repo: &Path,
    revision: &str,
    cancelled: &AtomicBool,
    phase: impl Fn(&str),
) -> Result<(), String> {
    let marker = repo.join("ownership-commit-graph-head");
    if std::fs::read_to_string(&marker).ok().as_deref() == Some(revision) {
        return Ok(());
    }
    phase("Indexing Git history");
    // Optional acceleration: unsupported Git versions or index failures must not
    // prevent a correct scan. Cancellation, however, always stops the job.
    if git_cancel(
        repo,
        &["commit-graph", "write", "--reachable", "--changed-paths"],
        cancelled,
    )
    .is_ok()
    {
        let _ = std::fs::write(marker, revision);
    }
    check_cancel(cancelled)
}

#[tauri::command]
pub fn cancel_line_ownership(job_id: String, control: State<'_, ScanControl>) {
    control.cancel(&job_id);
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSample {
    email: String,
    sha: String,
    role: String,
}

fn normalize_email(email: &str) -> String {
    email
        .trim()
        .trim_start_matches('<')
        .trim_end_matches('>')
        .to_lowercase()
}

/// One commit per git email that does not already name its GitHub account.
///
/// Git log is newest first, so the kept commit is the latest use of that email.
/// The author side wins when an email is used both ways: a lookup then reads
/// that side of the commit and cannot attach the other person's account.
fn account_samples(log: &str) -> Vec<AccountSample> {
    let mut as_author = BTreeMap::<String, String>::new();
    let mut as_committer = BTreeMap::<String, String>::new();
    for line in log.lines() {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split('\u{1f}');
        let sha = parts.next().unwrap_or("");
        if !is_commit_id(sha) {
            continue;
        }
        let author = normalize_email(parts.next().unwrap_or(""));
        let committer = normalize_email(parts.next().unwrap_or(""));
        if !author.is_empty() && github_account(&author).is_none() {
            as_author.entry(author).or_insert_with(|| sha.to_owned());
        }
        if !committer.is_empty() && github_account(&committer).is_none() {
            as_committer
                .entry(committer)
                .or_insert_with(|| sha.to_owned());
        }
    }
    let mut samples = Vec::new();
    for (email, sha) in &as_author {
        samples.push(AccountSample {
            email: email.clone(),
            sha: sha.clone(),
            role: "author".into(),
        });
    }
    for (email, sha) in &as_committer {
        if as_author.contains_key(email) {
            continue;
        }
        samples.push(AccountSample {
            email: email.clone(),
            sha: sha.clone(),
            role: "committer".into(),
        });
    }
    samples
}

/// Representative commits whose git emails the commits API can match to accounts.
#[tauri::command]
pub async fn line_ownership_account_samples(
    github_repo: String,
    job_id: String,
    app: tauri::AppHandle,
    control: State<'_, ScanControl>,
) -> Result<Vec<AccountSample>, String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("line-ownership");
    let active = control.begin(&github_repo, &job_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let repo = cache.join(format!("{}.git", github_repo.to_lowercase()));
        if !repo.exists() {
            return Ok(Vec::new());
        }
        match git_text_cancel(
            &repo,
            &[
                "log",
                "--format=%H%x1f%aE%x1f%cE",
                "--end-of-options",
                "HEAD",
            ],
            &active.cancelled,
        ) {
            Ok(log) => Ok(account_samples(&log)),
            Err(error) => {
                check_cancel(&active.cancelled)?;
                let lower = error.to_lowercase();
                if lower.contains("does not have any commits")
                    || lower.contains("unknown revision")
                    || lower.contains("bad revision")
                    || lower.contains("needed a single revision")
                {
                    Ok(Vec::new())
                } else {
                    Err(error)
                }
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
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
fn remote_git(
    repo: &Path,
    args: &[&str],
    token: Option<&str>,
    cancelled: &AtomicBool,
) -> Result<String, String> {
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
    match process::output(command, cancelled) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        Err(mut message) => {
            if let Some(auth) = auth {
                message = message.replace(&auth, "[redacted]");
            }
            if let Some(token) = token.filter(|t| !t.is_empty()) {
                message = message.replace(token, "[redacted]");
            }
            Err(format!("Could not download repository: {message}"))
        }
    }
}

fn same_commit(
    repo: &Path,
    reference: &str,
    sha: &str,
    cancelled: &AtomicBool,
) -> Result<bool, String> {
    match git_cancel(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{reference}^{{commit}}"),
        ],
        cancelled,
    ) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).trim() == sha),
        Err(_) => {
            check_cancel(cancelled)?;
            Ok(false)
        }
    }
}

fn aligned_default_branch(
    repo: &Path,
    head: &str,
    sha: &str,
    cancelled: &AtomicBool,
) -> Result<bool, String> {
    let symbolic = match git_cancel(repo, &["symbolic-ref", "--quiet", "HEAD"], cancelled) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).trim() == head,
        Err(_) => {
            check_cancel(cancelled)?;
            false
        }
    };
    Ok(symbolic && same_commit(repo, head, sha, cancelled)?)
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
    progress("Checking default branch");
    let refs = remote_git(
        cache,
        &["ls-remote", "--symref", "--", url, "HEAD"],
        token,
        cancelled,
    )?;
    let head = refs.lines().find_map(|line| {
        line.strip_prefix("ref: ")
            .and_then(|s| s.strip_suffix("\tHEAD"))
            .map(str::trim)
            .filter(|s| !s.is_empty())
    });
    let remote_revision = refs.lines().find_map(|line| {
        line.strip_suffix("\tHEAD")
            .map(str::trim)
            .filter(|s| !s.is_empty() && !s.starts_with("ref:"))
    });
    if head.is_none() && remote_revision.is_some() {
        return Err("Remote default branch is not a symbolic branch".into());
    }
    if let Some(head) = head {
        git_cancel(cache, &["check-ref-format", head], cancelled)?;
    }
    if let Some(sha) = remote_revision {
        if !is_commit_id(sha) {
            return Err("Remote HEAD is not a commit id".into());
        }
    }
    if remote_revision.is_none() {
        let heads = remote_git(
            cache,
            &["ls-remote", "--heads", "--", url],
            token,
            cancelled,
        )?;
        if !heads.trim().is_empty() {
            return Err("Remote HEAD does not identify a default branch".into());
        }
    }
    if !repo.exists() {
        progress("Cloning default branch history");
        let staging = repo.with_extension("cloning");
        if staging.exists() {
            std::fs::remove_dir_all(&staging).map_err(|e| e.to_string())?;
        }
        let mut args = vec!["clone", "--bare", "--single-branch", "--no-tags"];
        if let Some(branch) = head.and_then(|h| h.strip_prefix("refs/heads/")) {
            args.extend(["--branch", branch]);
        }
        args.extend(["--", url, staging.to_str().ok_or("Invalid cache path")?]);
        let result = remote_git(cache, &args, token, cancelled);
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&staging);
        }
        result?;
        std::fs::rename(&staging, &repo).map_err(|e| e.to_string())?;
    } else if let (Some(head), Some(sha)) = (head, remote_revision) {
        if !aligned_default_branch(&repo, head, sha, cancelled)? {
            let exists = git_cancel(
                &repo,
                &["cat-file", "-e", &format!("{sha}^{{commit}}")],
                cancelled,
            )
            .is_ok();
            check_cancel(cancelled)?;
            if exists {
                // No transfer is needed even after a branch rename or a rewind when
                // the advertised commit is already present in the full-history cache.
                git_cancel(&repo, &["update-ref", head, sha], cancelled)?;
            } else {
                progress("Updating default branch history");
                remote_git(
                    &repo,
                    &[
                        "fetch",
                        "--force",
                        "--no-tags",
                        "--",
                        url,
                        &format!("+{head}:{head}"),
                    ],
                    token,
                    cancelled,
                )?;
            }
            git_cancel(&repo, &["symbolic-ref", "HEAD", head], cancelled)?;
        }
    } else if !head_revision(&repo, cancelled)?.is_empty() {
        // An emptied remote must not silently display the old cached branch.
        return Err(
            "Remote repository no longer has a default branch; previous snapshot retained".into(),
        );
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
    fn parallel_streaming_matches_porcelain_reference_and_batches_binary_detection() {
        let repo = fixture();
        git(repo.path(), &["config", "user.name", "Ünika Example"]).unwrap();
        git(repo.path(), &["config", "user.email", "ünika@example.com"]).unwrap();
        fs::write(
            repo.path().join("space and ü.txt"),
            "one\ntwo\nthree\nfour\n",
        )
        .unwrap();
        fs::write(repo.path().join("empty.txt"), "").unwrap();
        fs::write(repo.path().join("binary.data"), b"hello\0world").unwrap();
        git(repo.path(), &["add", "."]).unwrap();
        git(
            repo.path(),
            &[
                "commit",
                "-m",
                "More files\n\nCo-authored-by: Helper <helper@x>",
            ],
        )
        .unwrap();
        fs::write(
            repo.path().join("space and ü.txt"),
            "one\nchanged\nthree\nchanged again\n",
        )
        .unwrap();
        git(repo.path(), &["add", "."]).unwrap();
        git(repo.path(), &["commit", "-m", "Noncontiguous blame groups"]).unwrap();
        let cancelled = AtomicBool::new(false);
        let reference = scan_snapshot_at(
            options(repo.path()),
            None,
            &cancelled,
            |_| {},
            None,
            1,
            false,
            None,
        )
        .unwrap();
        for (path, file) in &reference.files {
            if file.binary {
                continue;
            }
            let output = git_text(
                repo.path(),
                &[
                    "blame",
                    "--line-porcelain",
                    "--encoding=utf-8",
                    "-w",
                    &reference.report.revision,
                    "--",
                    path,
                ],
            )
            .unwrap();
            let mut counts = BTreeMap::new();
            parse_blame(&output, &mut counts);
            assert_eq!(
                serde_json::to_value(&counts).unwrap(),
                serde_json::to_value(&file.counts).unwrap()
            );
        }
        for workers in [2, 4, 8] {
            let parallel = scan_snapshot_at(
                options(repo.path()),
                None,
                &cancelled,
                |_| {},
                None,
                workers,
                false,
                None,
            )
            .unwrap();
            assert_eq!(
                serde_json::to_value(&reference).unwrap(),
                serde_json::to_value(&parallel).unwrap()
            );
        }
        let blob = git_text(repo.path(), &["rev-parse", "HEAD:binary.data"]).unwrap();
        let empty = git_text(repo.path(), &["rev-parse", "HEAD:empty.txt"]).unwrap();
        let mut early_nul = vec![b'a'; 20_000];
        early_nul[0] = 0;
        let mut late_nul = vec![b'a'; 20_000];
        late_nul[9000] = 0;
        let mut exact_nul = vec![b'b'; 8000];
        exact_nul[7999] = 0;
        let blobs = [
            ("early.bin", early_nul),
            ("late.bin", late_nul),
            ("exact.bin", exact_nul),
            ("text.bin", vec![b'a'; 20_000]),
        ];
        let mut hashed = Vec::new();
        for (name, bytes) in blobs {
            let path = repo.path().join(name);
            fs::write(&path, bytes).unwrap();
            hashed.push(
                git_text(repo.path(), &["hash-object", "-w", "--", name])
                    .unwrap()
                    .trim()
                    .to_owned(),
            );
        }
        assert_eq!(
            binary_blobs(
                repo.path(),
                &[
                    blob.trim(),
                    empty.trim(),
                    blob.trim(),
                    &hashed[0],
                    &hashed[1],
                    &hashed[2],
                    &hashed[3],
                ],
                &cancelled
            )
            .unwrap(),
            vec![true, false, true, true, false, true, false]
        );
        let missing = binary_blobs(repo.path(), &[&"f".repeat(40)], &cancelled).unwrap_err();
        assert!(
            missing.contains("Invalid blob"),
            "batch framing errors must survive process cleanup: {missing}"
        );
        let sha = "a".repeat(64);
        let text = format!("{sha} 1 1 2\nauthor Person\nauthor-mail <p@x>\nfilename test\n{sha} 3 5 4\nfilename test\n");
        let parsed = parse_incremental_reader(&mut std::io::Cursor::new(text)).unwrap();
        assert_eq!(parsed[&sha].lines, 6);
        assert_eq!(parsed[&sha].author.name, "Person");
    }

    #[test]
    fn metadata_and_job_scopes_do_not_reuse_incompatible_checkpoints_or_cancel_other_repos() {
        let repo = Path::new("/cache/org/repo.git");
        let mut metadata = CheckpointMetadata {
            version: SNAPSHOT_VERSION,
            revision: "abc".into(),
            options: managed_options(repo),
        };
        assert!(is_commit_id(&"ab".repeat(20)));
        assert!(is_commit_id(&"ab".repeat(32)));
        assert!(!is_commit_id("--upload-pack=evil"));
        assert!(!is_commit_id(&"abc"));
        assert!(matches_checkpoint(Some(&metadata), repo, "abc"));
        assert!(!matches_checkpoint(Some(&metadata), repo, "def"));
        metadata.options.ignore_whitespace = false;
        assert!(!matches_checkpoint(Some(&metadata), repo, "abc"));
        metadata.options = managed_options(repo);
        metadata.version += 1;
        assert!(!matches_checkpoint(Some(&metadata), repo, "abc"));
        let control = ScanControl::default();
        let one = control.begin("org/one", "first").unwrap();
        let two = control.begin("org/two", "second").unwrap();
        assert!(control.begin("ORG/ONE", "duplicate").is_err());
        control.cancel("first");
        assert!(one.cancelled.load(Ordering::Relaxed));
        assert!(!two.cancelled.load(Ordering::Relaxed));
        drop(one);
        let next = control.begin("org/one", "next").unwrap();
        control.cancel("first");
        assert!(!next.cancelled.load(Ordering::Relaxed));
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_terminates_git_style_process_groups_and_closes_pipes() {
        let cancelled = AtomicBool::new(false);
        let start = Instant::now();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(Duration::from_millis(80));
                cancelled.store(true, Ordering::SeqCst);
            });
            let mut command = Command::new("/bin/sh");
            command.args(["-c", "sleep 30 & wait"]);
            assert_eq!(
                process::output(command, &cancelled).unwrap_err(),
                "Scan cancelled"
            );
        });
        assert!(start.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn cancellation_during_scan_stops_before_a_snapshot() {
        let dir = fixture();
        let cancelled = AtomicBool::new(false);
        let error = match scan(options(dir.path()), &cancelled, |_| {
            cancelled.store(true, Ordering::SeqCst);
        }) {
            Err(error) => error,
            Ok(_) => panic!("cancellation must not produce a snapshot"),
        };
        assert_eq!(error, "Scan cancelled");
    }

    #[test]
    fn worker_failure_returns_the_git_error_and_no_snapshot() {
        let dir = fixture();
        let missing = dir.path().join("missing-revs");
        git(
            dir.path(),
            &["config", "blame.ignoreRevsFile", missing.to_str().unwrap()],
        )
        .unwrap();
        let error = match scan_snapshot(options(dir.path()), None, &AtomicBool::new(false), |_| {})
        {
            Err(error) => error,
            Ok(_) => panic!("a blame failure must not produce a snapshot"),
        };
        assert!(error.contains("Cannot blame"), "{error}");
        assert!(
            error.contains("missing-revs") || error.contains("object name list"),
            "{error}"
        );
    }

    #[test]
    fn sha256_repositories_match_porcelain_and_parallel_workers() {
        let dir = tempfile::tempdir().unwrap();
        git(
            dir.path(),
            &["init", "--object-format=sha256", "-b", "main"],
        )
        .unwrap();
        git(dir.path(), &["config", "user.name", "Alice Example"]).unwrap();
        git(dir.path(), &["config", "user.email", "alice@example.com"]).unwrap();
        git(dir.path(), &["config", "commit.gpgsign", "false"]).unwrap();
        fs::write(dir.path().join("code.txt"), "one\ntwo\n").unwrap();
        git(dir.path(), &["add", "."]).unwrap();
        git(dir.path(), &["commit", "-m", "Initial"]).unwrap();
        fs::write(dir.path().join("code.txt"), "one\nchanged\n").unwrap();
        git(dir.path(), &["add", "."]).unwrap();
        git(
            dir.path(),
            &[
                "commit",
                "--author",
                "Ünika Example <ünika@example.com>",
                "-m",
                "Edit",
            ],
        )
        .unwrap();
        let cancelled = AtomicBool::new(false);
        let reference = scan_snapshot_at(
            options(dir.path()),
            None,
            &cancelled,
            |_| {},
            None,
            1,
            false,
            None,
        )
        .unwrap();
        assert_eq!(reference.report.revision.len(), 64);
        for (path, file) in &reference.files {
            let output = git_text(
                dir.path(),
                &[
                    "blame",
                    "--line-porcelain",
                    "--encoding=utf-8",
                    "-w",
                    &reference.report.revision,
                    "--",
                    path,
                ],
            )
            .unwrap();
            let mut counts = BTreeMap::new();
            parse_blame(&output, &mut counts);
            assert_eq!(
                serde_json::to_value(&counts).unwrap(),
                serde_json::to_value(&file.counts).unwrap()
            );
        }
        let parallel = scan_snapshot_at(
            options(dir.path()),
            None,
            &cancelled,
            |_| {},
            None,
            4,
            false,
            None,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(&reference).unwrap(),
            serde_json::to_value(&parallel).unwrap()
        );
    }

    #[test]
    fn preparation_skips_unchanged_fetches_and_only_tracks_default_branch() {
        let origin = fixture();
        git(origin.path(), &["branch", "unrelated"]).unwrap();
        git(origin.path(), &["tag", "unneeded-tag"]).unwrap();
        let cache = tempfile::tempdir().unwrap();
        let cancel = AtomicBool::new(false);
        let repo = prepare_cache(
            cache.path(),
            "org/repo",
            origin.path().to_str().unwrap(),
            None,
            &cancel,
            |_| {},
        )
        .unwrap();
        assert!(git(&repo, &["show-ref", "--verify", "refs/heads/unrelated"]).is_err());
        assert!(git(&repo, &["show-ref", "--verify", "refs/tags/unneeded-tag"]).is_err());
        let phases = Mutex::new(Vec::new());
        prepare_cache(
            cache.path(),
            "org/repo",
            origin.path().to_str().unwrap(),
            None,
            &cancel,
            |p| phases.lock().unwrap().push(p.to_owned()),
        )
        .unwrap();
        assert!(!phases
            .lock()
            .unwrap()
            .iter()
            .any(|p| p.contains("Updating") || p.contains("Cloning")));
        let revision = head_revision(&repo, &cancel).unwrap();
        let before = scan_snapshot(options(&repo), None, &cancel, |_| {}).unwrap();
        update_commit_graph(&repo, &revision, &cancel, |_| {}).unwrap();
        let after = scan_snapshot(options(&repo), None, &cancel, |_| {}).unwrap();
        assert_eq!(
            serde_json::to_value(before).unwrap(),
            serde_json::to_value(after).unwrap()
        );
        update_commit_graph(&repo, &revision, &cancel, |_| {
            panic!("Index should be reused")
        })
        .unwrap();
        git(origin.path(), &["branch", "-m", "main", "trunk"]).unwrap();
        phases.lock().unwrap().clear();
        prepare_cache(
            cache.path(),
            "org/repo",
            origin.path().to_str().unwrap(),
            None,
            &cancel,
            |p| phases.lock().unwrap().push(p.to_owned()),
        )
        .unwrap();
        assert!(
            !phases
                .lock()
                .unwrap()
                .iter()
                .any(|p| p.contains("Updating") || p.contains("Cloning")),
            "renaming the default branch must not fetch a commit we already have"
        );
        assert_eq!(
            git_text(&repo, &["symbolic-ref", "HEAD"]).unwrap().trim(),
            "refs/heads/trunk"
        );
        assert_eq!(head_revision(&repo, &cancel).unwrap(), revision);
        fs::write(origin.path().join("code.txt"), "moved\n").unwrap();
        git(origin.path(), &["add", "."]).unwrap();
        git(
            origin.path(),
            &["commit", "-m", "Move default branch forward"],
        )
        .unwrap();
        phases.lock().unwrap().clear();
        prepare_cache(
            cache.path(),
            "org/repo",
            origin.path().to_str().unwrap(),
            None,
            &cancel,
            |p| phases.lock().unwrap().push(p.to_owned()),
        )
        .unwrap();
        assert!(phases
            .lock()
            .unwrap()
            .iter()
            .any(|p| p.contains("Updating")));
        let moved = head_revision(&repo, &cancel).unwrap();
        assert_ne!(moved, revision);
        git(origin.path(), &["reset", "--hard", &revision]).unwrap();
        phases.lock().unwrap().clear();
        prepare_cache(
            cache.path(),
            "org/repo",
            origin.path().to_str().unwrap(),
            None,
            &cancel,
            |p| phases.lock().unwrap().push(p.to_owned()),
        )
        .unwrap();
        assert!(
            !phases
                .lock()
                .unwrap()
                .iter()
                .any(|p| p.contains("Updating") || p.contains("Cloning")),
            "rewinding to a cached commit must not fetch"
        );
        assert_eq!(head_revision(&repo, &cancel).unwrap(), revision);
    }

    #[test]
    #[ignore = "Opt-in benchmark using a supplied local clone and NUL-delimited path/blob manifest"]
    fn benchmark_cached_repository() {
        let source = std::env::var("OWNERSHIP_BENCH_REPO").unwrap();
        let manifest = fs::read_to_string(std::env::var("OWNERSHIP_BENCH_FILES").unwrap()).unwrap();
        let cache = tempfile::tempdir().unwrap();
        let repo = cache.path().join("benchmark.git");
        git(
            cache.path(),
            &[
                "clone",
                "--bare",
                "--shared",
                "--",
                &source,
                repo.to_str().unwrap(),
            ],
        )
        .unwrap();
        let mut opts = options(&repo);
        opts.pathspecs = manifest
            .split_terminator('\0')
            .step_by(2)
            .map(str::to_owned)
            .collect();
        let cancel = AtomicBool::new(false);
        let revision = head_revision(&repo, &cancel).unwrap();
        let mut baseline = None;
        for indexed in [false, true] {
            if indexed {
                let start = Instant::now();
                update_commit_graph(&repo, &revision, &cancel, |_| {}).unwrap();
                println!("BENCH index-build {:.3}", start.elapsed().as_secs_f64());
            }
            for workers in [1, 4] {
                for _ in 0..3 {
                    let start = Instant::now();
                    let result = scan_snapshot_at(
                        opts.clone(),
                        None,
                        &cancel,
                        |_| {},
                        Some(&revision),
                        workers,
                        false,
                        None,
                    )
                    .unwrap();
                    println!(
                        "BENCH indexed={indexed} workers={workers} files={} seconds={:.3}",
                        result.files.len(),
                        start.elapsed().as_secs_f64()
                    );
                    let value = serde_json::to_value(&result).unwrap();
                    if let Some(expected) = &baseline {
                        assert_eq!(expected, &value);
                    } else {
                        baseline = Some(value);
                    }
                }
            }
        }
    }

    /// Opt-in: find the first first-parent commit where replay and blame disagree.
    ///   OWNERSHIP_BENCH_REPO=/path cargo test --release --lib history_replay_bisect -- --ignored --nocapture
    #[test]
    #[ignore = "Opt-in diagnostic using a supplied local clone"]
    fn history_replay_bisect() {
        let source = std::env::var("OWNERSHIP_BENCH_REPO").unwrap();
        let cache = tempfile::tempdir().unwrap();
        let repo = cache.path().join("bisect.git");
        git(cache.path(), &["clone", "--bare", "--shared", "--", &source, repo.to_str().unwrap()]).unwrap();
        let cancel = AtomicBool::new(false);
        let target = head_revision(&repo, &cancel).unwrap();
        let commits: Vec<String> = git_text(&repo, &["rev-list", "--first-parent", "--reverse", &target])
            .unwrap().lines().map(str::to_owned).collect();
        let replayed = |k: usize| {
            let dir = tempfile::tempdir().unwrap();
            let mut checkpoint = None;
            loop {
                let (batch, _) = advance_history_job(&repo, dir.path(), &commits[k], 1, checkpoint.as_deref(),
                    history::Engine::Replay, None, &history::BatchLimits { workers: worker_count(), ..Default::default() }, &cancel, |_, _| {}).unwrap();
                checkpoint = batch.checkpoint_ref.clone();
                if batch.done {
                    return history::read_checkpoint(dir.path(), checkpoint.as_deref().unwrap()).unwrap();
                }
            }
        };
        let agrees = |k: usize| replayed(k).origin_lines() == blame_origins(&repo, &commits[k]).0;
        let (mut good, mut bad) = (0usize, commits.len() - 1);
        assert!(!agrees(bad), "replay agrees with blame at the head");
        if !agrees(good) { bad = 0; }
        while bad > good + 1 {
            let mid = (good + bad) / 2;
            if agrees(mid) { good = mid } else { bad = mid }
            println!("BISECT good={good} bad={bad}");
        }
        let sha = &commits[bad];
        let state = replayed(bad).origin_lines();
        let (expected, _) = blame_origins(&repo, sha);
        println!("FIRST DIVERGENCE {bad} {sha}");
        for key in state.keys().chain(expected.keys()).collect::<BTreeSet<_>>() {
            if state.get(key) != expected.get(key) {
                println!("  origin {key}: replay {:?} blame {:?}", state.get(key), expected.get(key));
            }
        }
        println!("{}", git_text(&repo, &["show", "--stat", "-M", "--format=%H %P%n%s", sha]).unwrap());
    }

    /// Opt-in: time both history engines on a cached clone, count Git processes by
    /// command, report checkpoint size, and require identical results.
    ///   OWNERSHIP_BENCH_REPO=/path/to/clone cargo test --release --lib \
    ///     history_engine_benchmark -- --ignored --nocapture
    #[test]
    #[ignore = "Opt-in benchmark using a supplied local clone"]
    fn history_engine_benchmark() {
        let source = std::env::var("OWNERSHIP_BENCH_REPO").unwrap();
        let cache = tempfile::tempdir().unwrap();
        let repo = cache.path().join("benchmark.git");
        git(cache.path(), &["clone", "--bare", "--shared", "--", &source, repo.to_str().unwrap()]).unwrap();
        let cancel = AtomicBool::new(false);
        let target = head_revision(&repo, &cancel).unwrap();
        update_commit_graph(&repo, &target, &cancel, |_| {}).unwrap();
        let mut finals = Vec::new();
        // OWNERSHIP_BENCH_ENGINES=replay skips the slower reference walk.
        let engines: Vec<_> = std::env::var("OWNERSHIP_BENCH_ENGINES")
            .unwrap_or_else(|_| "replay,blame".into())
            .split(',')
            .map(|e| history::Engine::parse(e.trim()).unwrap())
            .collect();
        for engine in engines {
            let dir = tempfile::tempdir().unwrap();
            process::reset_spawned();
            let start = Instant::now();
            let mut checkpoint = None;
            let mut points = 0;
            let mut batches = 0;
            let fallbacks;
            let commits;
            loop {
                let (batch, _) = advance_history_job(
                    &repo, dir.path(), &target, 1, checkpoint.as_deref(), engine, None,
                    &history::BatchLimits { workers: worker_count(), ..Default::default() }, &cancel, |_, _| {},
                )
                .unwrap();
                batches += 1;
                points += batch.points.len();
                checkpoint = batch.checkpoint_ref.clone();
                if batch.done {
                    commits = batch.completed;
                    fallbacks = batch.fallbacks.clone();
                    finals.push(final_sets(batch.final_state.as_ref().unwrap()));
                    break;
                }
            }
            let seconds = start.elapsed().as_secs_f64();
            let bytes = fs::metadata(dir.path().join(checkpoint.unwrap())).unwrap().len();
            println!(
                "BENCH engine={engine:?} commits={commits} seconds={seconds:.3} ms_per_commit={:.2} batches={batches} day_points={points} checkpoint_bytes={bytes} fallbacks={fallbacks:?} git={:?}",
                seconds * 1000.0 / commits.max(1) as f64,
                process::spawned()
            );
        }
        assert!(finals.windows(2).all(|w| w[0] == w[1]), "every engine must end with the same attribution");
        let (_, report) = blame_origins(&repo, &target);
        assert_eq!(finals[0], credit_sets(&report), "and match a HEAD scan");
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
        let (authors, total, _) = aggregate(&commits, &BTreeMap::new(), &[], GroupBy::Person, true);
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
        assert_eq!(
            aggregate(&commits, &coauthors, &[], GroupBy::Person, true).1,
            5
        );
        assert_eq!(
            aggregate(&commits, &coauthors, &[], GroupBy::Name, false)
                .0
                .len(),
            4
        );
    }

    fn commit_as(repo: &Path, author: &str, message: &str) {
        git(repo, &["add", "code.txt"]).unwrap();
        git(repo, &["commit", "--author", author, "-m", message]).unwrap();
    }

    #[test]
    fn one_github_account_is_one_person_across_noreply_spellings() {
        let commits = BTreeMap::from([
            (
                "a".into(),
                CommitLines {
                    author: Identity {
                        name: "Nate Higgins".into(),
                        email: "nathggns@users.noreply.github.com".into(),
                    },
                    lines: 5,
                },
            ),
            (
                "b".into(),
                CommitLines {
                    author: Identity {
                        name: "nathggns".into(),
                        email: "719814+nathggns@users.noreply.github.com".into(),
                    },
                    lines: 11,
                },
            ),
            (
                "c".into(),
                CommitLines {
                    author: Identity {
                        name: "Old".into(),
                        email: "719814+oldlogin@users.noreply.github.com".into(),
                    },
                    lines: 2,
                },
            ),
        ]);
        let (authors, total, _) =
            aggregate(&commits, &BTreeMap::new(), &[], GroupBy::Person, false);
        assert_eq!(authors.len(), 1);
        assert_eq!(authors[0].author, "nathggns");
        assert_eq!(authors[0].lines, 18);
        assert_eq!(total, 18);
        let distinct = BTreeMap::from([
            (
                "a".into(),
                CommitLines {
                    author: Identity {
                        name: "Nate Higgins".into(),
                        email: "nathggns@users.noreply.github.com".into(),
                    },
                    lines: 5,
                },
            ),
            (
                "d".into(),
                CommitLines {
                    author: Identity {
                        name: "Someone Else".into(),
                        email: "9+someone@users.noreply.github.com".into(),
                    },
                    lines: 4,
                },
            ),
        ]);
        assert_eq!(
            aggregate(&distinct, &BTreeMap::new(), &[], GroupBy::Person, false)
                .0
                .len(),
            2
        );
    }

    #[test]
    fn history_joins_a_rewritten_identity_without_absorbing_the_committer() {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-b", "main"]).unwrap();
        git(dir.path(), &["config", "user.name", "Alice Example"]).unwrap();
        git(dir.path(), &["config", "user.email", "alice@example.com"]).unwrap();
        git(dir.path(), &["config", "commit.gpgsign", "false"]).unwrap();
        fs::write(dir.path().join("code.txt"), "old\n").unwrap();
        commit_as(dir.path(), "Nate Higgins <nate@x.com>", "Old");
        fs::write(dir.path().join("code.txt"), "bridge\n").unwrap();
        commit_as(
            dir.path(),
            "Nate Higgins <1+nathggns@users.noreply.github.com>",
            "Bridge",
        );
        fs::write(dir.path().join("code.txt"), "final\n").unwrap();
        commit_as(
            dir.path(),
            "nathggns <1+nathggns@users.noreply.github.com>",
            "Final",
        );
        let report = scan(options(dir.path()), &AtomicBool::new(false), |_| {}).unwrap();
        assert_eq!(report.authors.len(), 1);
        assert_eq!(report.authors[0].author, "nathggns");
        assert!(report.authors[0]
            .emails
            .iter()
            .any(|email| email == "nate@x.com"));
        assert!(report.authors[0]
            .emails
            .iter()
            .any(|email| email.contains("nathggns")));
        assert!(!report.authors[0]
            .emails
            .iter()
            .any(|email| email == "alice@example.com"));
    }

    #[test]
    fn a_sign_off_joins_identities_whose_lines_were_rewritten() {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-b", "main"]).unwrap();
        git(dir.path(), &["config", "user.name", "Alice Example"]).unwrap();
        git(dir.path(), &["config", "user.email", "alice@example.com"]).unwrap();
        git(dir.path(), &["config", "commit.gpgsign", "false"]).unwrap();
        fs::write(dir.path().join("code.txt"), "old\n").unwrap();
        commit_as(dir.path(), "Nate Higgins <nate@x.com>", "Old");
        fs::write(dir.path().join("code.txt"), "final\n").unwrap();
        commit_as(
            dir.path(),
            "nathggns <1+nathggns@users.noreply.github.com>",
            "Final\n\nSigned-off-by: Nate Higgins <1+nathggns@users.noreply.github.com>\n",
        );
        let report = scan(options(dir.path()), &AtomicBool::new(false), |_| {}).unwrap();
        assert_eq!(report.authors.len(), 1);
        assert_eq!(report.authors[0].author, "nathggns");
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
    fn assert_matches_full(incremental: &Snapshot, options: ScanOptions) {
        let full = scan_snapshot(options, None, &AtomicBool::new(false), |_| {}).unwrap();
        assert_eq!(incremental.report.revision, full.report.revision);
        assert_eq!(incremental.report.total_lines, full.report.total_lines);
        assert_eq!(
            incremental.report.coauthored_lines,
            full.report.coauthored_lines
        );
        assert_eq!(
            serde_json::to_value(&incremental.report.authors).unwrap(),
            serde_json::to_value(&full.report.authors).unwrap()
        );
        assert_eq!(
            serde_json::to_value(&incremental.files).unwrap(),
            serde_json::to_value(&full.files).unwrap()
        );
    }

    #[test]
    fn incremental_updates_additions_deletions_renames_and_reuses_untouched_files() {
        let dir = fixture();
        fs::write(dir.path().join("stable.txt"), "keep me\n").unwrap();
        fs::write(dir.path().join("delete.txt"), "delete me\n").unwrap();
        fs::write(dir.path().join("rename.txt"), "rename me\n").unwrap();
        git(dir.path(), &["add", "."]).unwrap();
        git(dir.path(), &["commit", "-m", "Extra files"]).unwrap();
        let cancel = AtomicBool::new(false);
        let initial = scan_snapshot(options(dir.path()), None, &cancel, |_| {}).unwrap();
        // Round-trip exactly the persisted representation, as a restarted app does.
        let restored: Snapshot =
            serde_json::from_str(&serde_json::to_string(&initial).unwrap()).unwrap();
        let same = scan_snapshot(options(dir.path()), Some(&restored), &cancel, |_| {}).unwrap();
        assert_eq!(same.report.files_recalculated, 0);
        assert_eq!(same.report.files_reused, initial.files.len());
        fs::write(dir.path().join("code.txt"), "replacement\ntwo\nthree\n").unwrap();
        fs::write(dir.path().join("added.txt"), "new\n").unwrap();
        fs::remove_file(dir.path().join("delete.txt")).unwrap();
        fs::rename(
            dir.path().join("rename.txt"),
            dir.path().join("renamed.txt"),
        )
        .unwrap();
        git(dir.path(), &["add", "."]).unwrap();
        git(
            dir.path(),
            &[
                "commit",
                "--author",
                "Carol <carol@example.com>",
                "-m",
                "Update",
            ],
        )
        .unwrap();
        let updated = scan_snapshot(options(dir.path()), Some(&restored), &cancel, |_| {}).unwrap();
        assert_eq!(updated.report.files_recalculated, 3);
        assert_eq!(updated.report.files_reused, 2); // stable text + binary
        assert!(!updated.files.contains_key("delete.txt"));
        assert!(!updated.files.contains_key("rename.txt"));
        assert_matches_full(&updated, options(dir.path()));
    }

    #[test]
    fn incremental_detects_change_then_revert_even_when_tree_diff_is_empty() {
        let dir = fixture();
        let cancel = AtomicBool::new(false);
        let initial = scan_snapshot(options(dir.path()), None, &cancel, |_| {}).unwrap();
        fs::write(dir.path().join("code.txt"), "temporary\ntwo\nthree\n").unwrap();
        git(dir.path(), &["add", "."]).unwrap();
        git(dir.path(), &["commit", "-m", "Temporary change"]).unwrap();
        fs::write(dir.path().join("code.txt"), "one\ntwo\nthree\n").unwrap();
        git(dir.path(), &["add", "."]).unwrap();
        git(
            dir.path(),
            &[
                "commit",
                "--author",
                "Carol <carol@example.com>",
                "-m",
                "Restore content",
            ],
        )
        .unwrap();
        assert!(git_text(
            dir.path(),
            &["diff", "--name-only", &initial.report.revision, "HEAD"]
        )
        .unwrap()
        .is_empty());
        let updated = scan_snapshot(options(dir.path()), Some(&initial), &cancel, |_| {}).unwrap();
        assert_eq!(updated.report.files_recalculated, 1);
        assert!(updated
            .report
            .authors
            .iter()
            .any(|a| a.author == "Carol" && a.lines == 1));
        assert_matches_full(&updated, options(dir.path()));
    }

    #[test]
    fn incremental_rebuilds_after_mailmap_changes_rewritten_history_or_cache_version_change() {
        let dir = fixture();
        let cancel = AtomicBool::new(false);
        let initial = scan_snapshot(options(dir.path()), None, &cancel, |_| {}).unwrap();
        fs::write(
            dir.path().join(".mailmap"),
            "Canonical Alice <canonical@example.com> Alice Example <alice@example.com>\n",
        )
        .unwrap();
        git(dir.path(), &["add", "."]).unwrap();
        git(dir.path(), &["commit", "-m", "Identity correction"]).unwrap();
        let mapped = scan_snapshot(options(dir.path()), Some(&initial), &cancel, |_| {}).unwrap();
        assert_eq!(mapped.report.files_reused, 0);
        assert_matches_full(&mapped, options(dir.path()));
        git(dir.path(), &["reset", "--hard", &initial.report.revision]).unwrap();
        let rewritten = scan_snapshot(options(dir.path()), Some(&mapped), &cancel, |_| {}).unwrap();
        assert_eq!(rewritten.report.files_reused, 0);
        assert_matches_full(&rewritten, options(dir.path()));
        let mut outdated = initial;
        outdated.version = 0;
        assert_eq!(
            scan_snapshot(options(dir.path()), Some(&outdated), &cancel, |_| {})
                .unwrap()
                .report
                .files_reused,
            0
        );
        let full = scan_snapshot(options(dir.path()), None, &cancel, |_| {}).unwrap();
        assert_eq!(full.report.files_reused, 0);
    }

    #[test]
    fn incremental_merge_matches_full_attribution() {
        let dir = fixture();
        let cancel = AtomicBool::new(false);
        let initial = scan_snapshot(options(dir.path()), None, &cancel, |_| {}).unwrap();
        git(dir.path(), &["checkout", "-b", "feature"]).unwrap();
        fs::write(dir.path().join("code.txt"), "feature\ntwo\nthree\n").unwrap();
        git(dir.path(), &["add", "."]).unwrap();
        git(
            dir.path(),
            &[
                "commit",
                "--author",
                "Carol <carol@example.com>",
                "-m",
                "Feature",
            ],
        )
        .unwrap();
        git(dir.path(), &["checkout", "main"]).unwrap();
        git(
            dir.path(),
            &["merge", "--no-ff", "feature", "-m", "Merge feature"],
        )
        .unwrap();
        let updated = scan_snapshot(options(dir.path()), Some(&initial), &cancel, |_| {}).unwrap();
        assert_matches_full(&updated, options(dir.path()));
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

    fn head_sha(repo: &Path) -> String {
        git_text(repo, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_owned()
    }
    fn commit_all(repo: &Path, message: &str) {
        git(repo, &["add", "-A"]).unwrap();
        git(repo, &["commit", "-q", "--allow-empty", "-m", message]).unwrap();
    }
    fn commit_dated(repo: &Path, author: &str, date: &str, message: &str) {
        git(repo, &["add", "-A"]).unwrap();
        let output = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["commit", "-q", "--allow-empty", "--author", author, "-m", message])
            .env("GIT_COMMITTER_DATE", date)
            .env("GIT_AUTHOR_DATE", date)
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    }

    /// Surviving lines per origin commit from a full blame at `sha`: the oracle.
    fn blame_origins(repo: &Path, sha: &str) -> (BTreeMap<String, u64>, Report) {
        let snapshot = scan_snapshot_at(
            options(repo),
            None,
            &AtomicBool::new(false),
            |_| {},
            Some(sha),
            2,
            false,
            None,
        )
        .unwrap();
        let mut counts = BTreeMap::new();
        for file in snapshot.files.values().filter(|f| !f.binary) {
            for (origin, lines) in &file.counts {
                *counts.entry(origin.clone()).or_default() += lines.lines;
            }
        }
        counts.retain(|_, lines| *lines > 0);
        (counts, snapshot.report)
    }

    /// Credits as sets of identity tuples, the shape both sides can be compared in.
    fn credit_sets(report: &Report) -> BTreeMap<Vec<(String, String)>, u64> {
        let mut out = BTreeMap::new();
        for credit in &report.credits {
            let mut people: Vec<_> = credit
                .people
                .iter()
                .map(|p| (p.name.clone(), p.email.clone()))
                .collect();
            people.sort();
            people.dedup();
            *out.entry(people).or_default() += credit.lines;
        }
        out
    }
    fn final_sets(state: &history::FinalState) -> BTreeMap<Vec<(String, String)>, u64> {
        let mut out = BTreeMap::new();
        for (people, lines) in &state.groups {
            let mut people = people.clone();
            people.sort();
            *out.entry(people).or_default() += *lines;
        }
        out
    }

    fn one_at_a_time() -> history::BatchLimits {
        history::BatchLimits {
            time_budget: Duration::from_secs(60),
            max_commits: 1,
            chunk: 1,
            workers: 2,
        }
    }

    /// Walk to HEAD one commit per batch, reloading the checkpoint from disk on
    /// every other batch, and compare each commit with a full blame.
    fn assert_walk_matches_blame(repo: &Path, engine: history::Engine) -> BTreeMap<String, u64> {
        let dir = tempfile::tempdir().unwrap();
        let target = head_sha(repo);
        let commits = git_text(repo, &["rev-list", "--first-parent", "--reverse", &target]).unwrap();
        let commits: Vec<_> = commits.lines().map(str::to_owned).collect();
        let mut checkpoint: Option<String> = None;
        let mut job: Option<history::Job> = None;
        let mut fallbacks = BTreeMap::new();
        for (step, sha) in commits.iter().enumerate() {
            let remembered = if step % 2 == 0 { job.take() } else { None };
            let (batch, next) = advance_history_job(
                repo,
                dir.path(),
                &target,
                1,
                checkpoint.as_deref(),
                engine,
                remembered,
                &one_at_a_time(),
                &AtomicBool::new(false),
                |_, _| {},
            )
            .unwrap();
            assert!(!batch.needs_reset, "step {step} should continue");
            assert_eq!(batch.cursor.as_deref(), Some(sha.as_str()));
            checkpoint = batch.checkpoint_ref.clone();
            let state = history::read_checkpoint(dir.path(), checkpoint.as_deref().unwrap()).unwrap();
            let (expected, report) = blame_origins(repo, sha);
            assert_eq!(state.origin_lines(), expected, "{engine:?} differs from blame at step {step} ({sha})");
            assert_eq!(final_sets(&state.final_state()), credit_sets(&report), "{engine:?} credits at step {step}");
            fallbacks = batch.fallbacks.clone();
            job = next;
            assert_eq!(batch.done, step + 1 == commits.len());
            if batch.done {
                assert_eq!(final_sets(batch.final_state.as_ref().unwrap()), credit_sets(&report));
            }
        }
        fallbacks
    }

    /// Every kind of change the replay engine must agree with blame on.
    fn replay_matrix() -> tempfile::TempDir {
        let dir = fixture();
        let repo = dir.path();
        let bob = "Bob Example <bob@example.com>";
        let carol = "Carol Example <carol@example.com>";
        fs::write(repo.join("code.txt"), "one\n  two\nthree\nfour\n").unwrap();
        commit_dated(repo, bob, "2020-01-02T10:00:00Z", "Whitespace and an insertion");
        fs::write(repo.join("code.txt"), "one\ntwo\n\nthree\nfour\nfive\n").unwrap();
        commit_dated(repo, carol, "2020-01-02T09:00:00Z", "Earlier time, same day");
        fs::write(repo.join("crlf.txt"), "a\r\nb\r\nc").unwrap();
        fs::write(repo.join("big.txt"), (0..400).map(|i| format!("line {i}\n")).collect::<String>()).unwrap();
        commit_dated(repo, bob, "2020-01-03T00:00:00Z", "CRLF, no final newline, a large file");
        fs::write(repo.join("crlf.txt"), "a\r\nB\r\nc\r\n").unwrap();
        let big: String = (0..400)
            .map(|i| if i % 7 == 0 { format!("changed {i}\n") } else { format!("line {i}\n") })
            .collect();
        fs::write(repo.join("big.txt"), big).unwrap();
        commit_dated(repo, carol, "2020-01-04T00:00:00Z", "Large scattered hunks\n\nCo-authored-by: Bob Example <bob@example.com>");
        git(repo, &["mv", "big.txt", "renamed.txt"]).unwrap();
        fs::write(repo.join("renamed.txt"), fs::read_to_string(repo.join("renamed.txt")).unwrap() + "tail\n").unwrap();
        commit_dated(repo, bob, "2020-01-05T00:00:00Z", "Rename plus edit");
        fs::remove_file(repo.join("crlf.txt")).unwrap();
        commit_dated(repo, bob, "2020-01-06T00:00:00Z", "Delete");
        fs::write(repo.join("crlf.txt"), "a\r\nB\r\nc\r\n").unwrap();
        commit_dated(repo, carol, "2020-01-07T00:00:00Z", "Restore the deleted file");
        fs::write(repo.join("binary"), "now text\nreally\n").unwrap();
        fs::write(repo.join("image.png"), b"\x89PNG\0").unwrap();
        fs::write(repo.join("yarn.lock"), "generated\n").unwrap();
        commit_dated(repo, bob, "2020-01-08T00:00:00Z", "Binary becomes text, excluded files");
        #[cfg(unix)]
        std::os::unix::fs::symlink("code.txt", repo.join("link.txt")).unwrap();
        fs::write(repo.join("code.txt"), "one\ntwo\n\nthree\nfour\nfive\nsix\n").unwrap();
        commit_dated(repo, "Alice Example <alice@example.com>", "2020-01-08T00:00:00Z", "Symlink, equal timestamp\n\nCo-authored-by: Alice Example <alice@example.com>");
        git(repo, &["checkout", "-q", "-b", "feature"]).unwrap();
        fs::write(repo.join("feature.txt"), "side one\nside two\n").unwrap();
        fs::write(repo.join("code.txt"), "one\ntwo\n\nthree\nfour\nfive\nsix\nfrom side\n").unwrap();
        commit_dated(repo, carol, "2020-01-09T00:00:00Z", "Side branch");
        git(repo, &["checkout", "-q", "main"]).unwrap();
        fs::write(repo.join("main.txt"), "main only\n").unwrap();
        commit_dated(repo, bob, "2020-01-09T12:00:00Z", "Main moves on");
        let output = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["merge", "-q", "--no-ff", "feature", "-m", "Merge feature"])
            .env("GIT_COMMITTER_DATE", "2020-01-10T00:00:00Z")
            .output()
            .unwrap();
        assert!(output.status.success());
        fs::write(repo.join("feature.txt"), "side one\nedited after merge\n").unwrap();
        commit_dated(repo, bob, "2020-01-01T00:00:00Z", "Clock went backwards");
        git(repo, &["mv", "renamed.txt", "moved.txt"]).unwrap();
        fs::write(repo.join("renamed.txt"), "a brand new file at the old path\n").unwrap();
        git(repo, &["mv", "image.png", "moved.png"]).unwrap();
        git(repo, &["mv", "main.txt", "vendor.min.js"]).unwrap();
        commit_dated(repo, carol, "2020-01-11T00:00:00Z", "Exact rename, old path reused, binary and excluded renames");
        dir
    }

    #[test]
    fn blame_engine_matches_a_full_blame_at_every_commit() {
        let dir = replay_matrix();
        assert_walk_matches_blame(dir.path(), history::Engine::Blame);
    }

    #[test]
    fn replay_engine_matches_a_full_blame_at_every_commit_and_records_fallbacks() {
        let dir = replay_matrix();
        let fallbacks = assert_walk_matches_blame(dir.path(), history::Engine::Replay);
        assert!(fallbacks.get("merge").copied().unwrap_or(0) >= 1, "{fallbacks:?}");
        assert!(fallbacks.get("rename").copied().unwrap_or(0) >= 1, "a contested rename is blamed: {fallbacks:?}");
        let binary_to_text = fallbacks.get("attributes").copied().unwrap_or(0) + fallbacks.get("transition").copied().unwrap_or(0);
        assert!(binary_to_text >= 1, "a binary file becoming text is re-blamed: {fallbacks:?}");
    }

    /// Blame looks for each new path's rename source on its own; full `-M`
    /// detection pairs each deleted file with at most one new path.
    fn rename_contention(variant: &str) -> tempfile::TempDir {
        let dir = fixture();
        let repo = dir.path();
        let body = |tag: &str| (0..20).map(|i| format!("{tag} line {i}\n")).collect::<String>();
        let bob = "Bob Example <bob@example.com>";
        fs::write(repo.join("a.txt"), body("shared")).unwrap();
        fs::write(repo.join("x.txt"), body("other")).unwrap();
        commit_dated(repo, "Alice Example <alice@example.com>", "2020-01-02T00:00:00Z", "Originals");
        match variant {
            // One deleted file, two new near-copies of it.
            "duplicate" => {
                fs::remove_file(repo.join("a.txt")).unwrap();
                fs::write(repo.join("b.txt"), body("shared") + "b tail\n").unwrap();
                fs::write(repo.join("c.txt"), body("shared") + "c tail\n").unwrap();
            }
            // Two deleted files that both resemble one new path, plus a weaker second path.
            _ => {
                fs::remove_file(repo.join("a.txt")).unwrap();
                fs::remove_file(repo.join("x.txt")).unwrap();
                let mixed: String = (0..20).map(|i| if i < 12 { format!("shared line {i}\n") } else { format!("other line {i}\n") }).collect();
                fs::write(repo.join("m.txt"), mixed).unwrap();
                fs::write(repo.join("n.txt"), body("shared")).unwrap();
            }
        }
        commit_dated(repo, bob, "2020-01-03T00:00:00Z", "Split and move");
        dir
    }

    #[test]
    fn replay_follows_renames_the_way_blame_does() {
        for variant in ["duplicate", "competing"] {
            let dir = rename_contention(variant);
            assert_walk_matches_blame(dir.path(), history::Engine::Replay);
        }
    }

    #[test]
    fn replay_uses_fewer_blame_processes_than_the_blame_engine() {
        let dir = replay_matrix();
        let repo = dir.path();
        let target = head_sha(repo);
        let count_blames = |engine| {
            let checkpoints = tempfile::tempdir().unwrap();
            process::reset_spawned();
            let (batch, _) = advance_history_job(
                repo, checkpoints.path(), &target, 1, None, engine, None,
                &history::BatchLimits::default(), &AtomicBool::new(false), |_, _| {},
            )
            .unwrap();
            assert!(batch.done);
            process::spawned().get("blame").copied().unwrap_or(0)
        };
        let blame = count_blames(history::Engine::Blame);
        let replay = count_blames(history::Engine::Replay);
        assert!(replay < blame, "replay ran {replay} blames, blame engine {blame}");
    }

    /// The saved-history rule: the day's point is the latest committer second, then the greater SHA.
    #[test]
    fn day_points_reproduce_the_saved_history_rule_with_out_of_order_times() {
        let dir = replay_matrix();
        let repo = dir.path();
        let target = head_sha(repo);
        let log = git_text(repo, &["log", "--first-parent", "--format=%H %ct", &target]).unwrap();
        let mut expected = BTreeMap::<i64, (i64, String)>::new();
        for line in log.lines() {
            let (sha, unix) = line.split_once(' ').unwrap();
            let unix: i64 = unix.parse().unwrap();
            let entry = expected.entry(unix.div_euclid(86_400)).or_insert((i64::MIN, String::new()));
            if (unix, sha) > (entry.0, entry.1.as_str()) {
                *entry = (unix, sha.to_owned());
            }
        }
        for limits in [one_at_a_time(), history::BatchLimits { chunk: 3, max_commits: 5, ..Default::default() }] {
            let checkpoints = tempfile::tempdir().unwrap();
            let mut saved = BTreeMap::<i64, (i64, String, u64)>::new();
            let mut checkpoint = None;
            loop {
                let (batch, _) = advance_history_job(
                    repo, checkpoints.path(), &target, 1, checkpoint.as_deref(), history::Engine::Replay,
                    None, &limits, &AtomicBool::new(false), |_, _| {},
                )
                .unwrap();
                // What the database upsert does with each row.
                for point in &batch.points {
                    let unix = git_text(repo, &["show", "-s", "--format=%ct", &point.revision]).unwrap().trim().parse::<i64>().unwrap();
                    let day = unix.div_euclid(86_400);
                    let better = saved.get(&day).is_none_or(|(u, s, _)| (unix, point.revision.as_str()) > (*u, s.as_str()));
                    if better {
                        saved.insert(day, (unix, point.revision.clone(), point.total_lines));
                    }
                }
                checkpoint = batch.checkpoint_ref.clone();
                if batch.done {
                    break;
                }
            }
            assert_eq!(saved.len(), expected.len());
            for (day, (unix, sha, total)) in &saved {
                assert_eq!(&expected[day], &(*unix, sha.clone()), "day {day}");
                assert_eq!(*total, blame_origins(repo, sha).1.total_lines, "levels at {sha}");
            }
        }
    }

    #[test]
    fn checkpoints_resume_reject_corruption_and_reset_on_rewrites() {
        let dir = replay_matrix();
        let repo = dir.path();
        let target = head_sha(repo);
        let checkpoints = tempfile::tempdir().unwrap();
        let limits = history::BatchLimits { chunk: 2, max_commits: 3, ..Default::default() };
        let run = |checkpoint: Option<&str>, generation: i64, engine| {
            advance_history_job(
                repo, checkpoints.path(), &target, generation, checkpoint, engine, None, &limits,
                &AtomicBool::new(false), |_, _| {},
            )
            .unwrap()
            .0
        };
        let first = run(None, 1, history::Engine::Replay);
        assert!(!first.done && !first.needs_reset);
        let name = first.checkpoint_ref.clone().unwrap();
        // An uncommitted newer checkpoint is an orphan: the caller retries from `name`.
        let orphan = run(Some(&name), 1, history::Engine::Replay).checkpoint_ref.unwrap();
        let retried = run(Some(&name), 1, history::Engine::Replay);
        assert!(!checkpoints.path().join(&orphan).exists(), "orphans are pruned");
        assert!(checkpoints.path().join(&name).exists(), "the committed checkpoint is kept until replaced");
        assert_eq!(retried.cursor, run(Some(&name), 1, history::Engine::Replay).cursor, "retries are deterministic");
        assert!(run(Some(&name), 2, history::Engine::Replay).needs_reset, "another generation cannot reuse it");
        assert!(run(Some(&name), 1, history::Engine::Blame).needs_reset, "another engine cannot reuse it");
        let mut bytes = fs::read(checkpoints.path().join(&name)).unwrap();
        let last = bytes.len() - 2;
        bytes[last] ^= 1;
        fs::write(checkpoints.path().join(&name), bytes).unwrap();
        assert!(history::read_checkpoint(checkpoints.path(), &name).is_err());
        assert!(run(Some(&name), 1, history::Engine::Replay).needs_reset, "corruption restarts in a new generation");
        assert!(run(Some("../escape"), 1, history::Engine::Replay).needs_reset);

        // Finish, then rewrite the branch: the cursor is no longer a first parent.
        let mut checkpoint = None;
        loop {
            let batch = run(checkpoint.as_deref(), 3, history::Engine::Replay);
            checkpoint = batch.checkpoint_ref.clone();
            if batch.done {
                break;
            }
        }
        let done = checkpoint.unwrap();
        let (again, _) = advance_history_job(
            repo, checkpoints.path(), &target, 3, Some(&done), history::Engine::Replay, None, &limits,
            &AtomicBool::new(false), |_, _| {},
        )
        .unwrap();
        assert!(again.done && again.points.is_empty(), "an unchanged target has nothing to do");
        git(repo, &["reset", "-q", "--hard", "HEAD~2"]).unwrap();
        fs::write(repo.join("code.txt"), "rewritten\n").unwrap();
        commit_all(repo, "Force-pushed");
        let rewritten = head_sha(repo);
        let (reset, _) = advance_history_job(
            repo, checkpoints.path(), &rewritten, 3, Some(&done), history::Engine::Replay, None, &limits,
            &AtomicBool::new(false), |_, _| {},
        )
        .unwrap();
        assert!(reset.needs_reset);
    }

    #[test]
    fn a_mailmap_change_resets_history_and_new_commits_extend_it() {
        let dir = fixture();
        let repo = dir.path();
        let checkpoints = tempfile::tempdir().unwrap();
        let walk = |target: &str, checkpoint: Option<&str>| {
            advance_history_job(
                repo, checkpoints.path(), target, 1, checkpoint, history::Engine::Replay, None,
                &history::BatchLimits::default(), &AtomicBool::new(false), |_, _| {},
            )
            .unwrap()
            .0
        };
        let first = walk(&head_sha(repo), None);
        assert!(first.done);
        fs::write(repo.join("code.txt"), "one\ntwo\nthree\nfour\n").unwrap();
        commit_all(repo, "Append");
        let extended = walk(&head_sha(repo), first.checkpoint_ref.as_deref());
        assert!(!extended.needs_reset && extended.done);
        assert_eq!(extended.completed, 2);
        assert!(extended.identities.is_empty(), "known identities are not sent again");
        fs::write(repo.join(".mailmap"), "Alice Renamed <alice@example.com> Alice Example <alice@example.com>\n").unwrap();
        commit_all(repo, "Mailmap");
        assert!(walk(&head_sha(repo), extended.checkpoint_ref.as_deref()).needs_reset);
        let rebuilt = walk(&head_sha(repo), None);
        assert!(rebuilt.identities.iter().any(|(_, name, _)| name == "Alice Renamed"));
        let (_, report) = blame_origins(repo, &head_sha(repo));
        assert_eq!(final_sets(rebuilt.final_state.as_ref().unwrap()), credit_sets(&report));
    }

    #[test]
    fn permits_bound_concurrency_and_stop_waiting_on_cancel() {
        let permits = Permits::new(2);
        let running = AtomicBool::new(false);
        let a = permits.acquire(&running).unwrap();
        let _b = permits.acquire(&running).unwrap();
        let cancelled = AtomicBool::new(true);
        assert!(permits.acquire(&cancelled).is_err(), "a cancelled job does not wait for a slot");
        drop(a);
        assert!(permits.acquire(&running).is_ok(), "a released slot is reused");
        assert_eq!(Permits::new(2).workers(), (worker_count() / 2).max(1));
    }

    #[test]
    fn head_cache_files_are_named_once_and_invalid_names_are_refused() {
        let dir = fixture();
        let snapshot = scan_snapshot(options(dir.path()), None, &AtomicBool::new(false), |_| {}).unwrap();
        let heads = tempfile::tempdir().unwrap();
        let one = write_head_cache(heads.path(), &snapshot).unwrap();
        let two = write_head_cache(heads.path(), &snapshot).unwrap();
        assert_ne!(one, two);
        assert!(read_head_cache(heads.path(), &one).is_some());
        assert!(read_head_cache(heads.path(), "../../etc/passwd").is_none());
        let scan = scan_result(&snapshot, two.clone()).unwrap();
        assert!(!scan.report.contains("\"files\""), "the page never receives the file cache");
        assert!(scan.metadata.contains("\"revision\""));
        history::prune_checkpoints(heads.path(), &[two.as_str()]);
        assert!(!heads.path().join(&one).exists());
    }

    #[test]
    fn account_samples_keep_one_commit_per_email_and_skip_noreply() {
        let author = format!("{:040x}", 1);
        let later = format!("{:040x}", 2);
        let committer_only = format!("{:040x}", 3);
        let log = format!(
            "{author}\u{1f}Aaron@Gmail.com\u{1f}other@x.com\n{later}\u{1f}aaron@gmail.com\u{1f}committer@x.com\n{committer_only}\u{1f}1+login@users.noreply.github.com\u{1f}solo@x.com\n"
        );
        let samples = account_samples(&log);
        let by_email: BTreeMap<_, _> = samples
            .iter()
            .map(|sample| (sample.email.as_str(), sample))
            .collect();
        assert_eq!(by_email["aaron@gmail.com"].sha, author);
        assert_eq!(by_email["aaron@gmail.com"].role, "author");
        assert_eq!(by_email["other@x.com"].role, "committer");
        assert_eq!(by_email["other@x.com"].sha, author);
        assert_eq!(by_email["committer@x.com"].role, "committer");
        assert_eq!(by_email["solo@x.com"].role, "committer");
        assert!(!by_email.contains_key("1+login@users.noreply.github.com"));
        assert_eq!(samples.len(), 4);
    }
}
