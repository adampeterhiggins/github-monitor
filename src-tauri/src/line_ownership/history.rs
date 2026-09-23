//! Daily ownership history: a walk over every first-parent commit that keeps one
//! origin commit per surviving text line.
//!
//! Two engines share the walk. `Blame` re-blames every changed text file at each
//! commit and is the reference. `Replay` applies each commit's `-U0 -w` diff to the
//! previous line origins, which is what `git blame -w` does on a linear history,
//! and falls back to blame whenever it cannot be sure: merges, a commit that both
//! deletes and adds files (blame may follow a rename), binary transitions, and any
//! hunk that does not line up. Both keep raw identities; account resolution
//! happens later, so a new mapping never rewrites this state.
use super::{
    binary_blobs, check_cancel, git_command, is_commit_id, parse_coauthors, process, Identity,
    ScanOptions, BINARY, GENERATED,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

/// Benchmarks only: trust full `-M` pairing, as the faster (unsafe) variant did.
#[cfg(test)]
pub static PLAIN_RENAME_PAIRING: AtomicBool = AtomicBool::new(false);

fn plain_rename_pairing() -> bool {
    #[cfg(test)]
    return PLAIN_RENAME_PAIRING.load(Ordering::Relaxed);
    #[cfg(not(test))]
    false
}

/// Version of the saved day rows. Bump when their meaning changes.
pub const HISTORY_FORMAT: u32 = 2;
/// Version of the native checkpoint file.
const CHECKPOINT_FORMAT: u32 = 1;

/// Diff settings pinned for every blame and patch, so a user's Git config cannot
/// make the replayed diff disagree with blame.
pub const DIFF_CONFIG: [&str; 4] = [
    "-c",
    "diff.algorithm=myers",
    "-c",
    "diff.indentHeuristic=true",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Blame,
    Replay,
}

impl Engine {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "blame" => Ok(Engine::Blame),
            "replay" => Ok(Engine::Replay),
            _ => Err(format!("Unknown ownership history engine {value}")),
        }
    }
}

#[derive(Clone, Debug)]
pub struct WalkCommit {
    pub sha: String,
    pub parents: Vec<String>,
    pub unix: i64,
    pub committed_at: String,
    pub author: Identity,
}

#[derive(Clone, Debug, Default)]
struct FileLines {
    blob: String,
    origins: Vec<u32>,
}

/// Everything the walk needs to continue. Raw identities, origin commits and
/// credit groups are interned; the checkpoint stores the same data.
pub struct HistoryState {
    pub engine: Engine,
    pub generation: i64,
    options_hash: String,
    mailmap: String,
    pub target: String,
    pub cursor: Option<String>,
    applied: usize,
    identities: Vec<Identity>,
    identity_index: HashMap<Identity, u32>,
    emitted_identities: usize,
    origins: Vec<String>,
    origin_index: HashMap<String, u32>,
    origin_group: Vec<u32>,
    groups: Vec<Vec<u32>>,
    group_index: HashMap<Vec<u32>, u32>,
    group_lines: Vec<i64>,
    files: BTreeMap<String, FileLines>,
    /// Best (committer seconds, SHA) seen per UTC day, so a known loser is not sent.
    day_best: BTreeMap<i64, (i64, String)>,
    fallbacks: BTreeMap<String, u64>,
}

pub fn options_hash(options: &ScanOptions) -> String {
    let mut normalized = options.clone();
    normalized.repo = String::new();
    let text = serde_json::to_string(&normalized).unwrap_or_default();
    format!("{:016x}", fnv1a(text.as_bytes()))
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

impl HistoryState {
    pub fn fresh(engine: Engine, generation: i64, options: &ScanOptions, mailmap: String) -> Self {
        HistoryState {
            engine,
            generation,
            options_hash: options_hash(options),
            mailmap,
            target: String::new(),
            cursor: None,
            applied: 0,
            identities: Vec::new(),
            identity_index: HashMap::new(),
            emitted_identities: 0,
            origins: Vec::new(),
            origin_index: HashMap::new(),
            origin_group: Vec::new(),
            groups: Vec::new(),
            group_index: HashMap::new(),
            group_lines: Vec::new(),
            files: BTreeMap::new(),
            day_best: BTreeMap::new(),
            fallbacks: BTreeMap::new(),
        }
    }

    fn identity(&mut self, person: &Identity) -> u32 {
        if let Some(id) = self.identity_index.get(person) {
            return *id;
        }
        let id = self.identities.len() as u32;
        self.identities.push(person.clone());
        self.identity_index.insert(person.clone(), id);
        id
    }

    fn group(&mut self, people: &[Identity]) -> u32 {
        let mut ids: Vec<u32> = people.iter().map(|p| self.identity(p)).collect();
        ids.sort_unstable();
        ids.dedup();
        if let Some(group) = self.group_index.get(&ids) {
            return *group;
        }
        let group = self.groups.len() as u32;
        self.groups.push(ids.clone());
        self.group_index.insert(ids, group);
        self.group_lines.push(0);
        group
    }

    fn origin(&self, sha: &str) -> Option<u32> {
        self.origin_index.get(sha).copied()
    }

    fn add_origin(&mut self, sha: &str, author: &Identity, coauthors: &[Identity]) -> u32 {
        if let Some(origin) = self.origin(sha) {
            return origin;
        }
        let people: Vec<Identity> = std::iter::once(author.clone())
            .chain(coauthors.iter().cloned())
            .collect();
        let group = self.group(&people);
        let origin = self.origins.len() as u32;
        self.origins.push(sha.to_owned());
        self.origin_index.insert(sha.to_owned(), origin);
        self.origin_group.push(group);
        origin
    }

    fn count(&mut self, origins: &[u32], sign: i64) {
        for origin in origins {
            self.group_lines[self.origin_group[*origin as usize] as usize] += sign;
        }
    }

    fn replace_file(&mut self, path: &str, file: Option<FileLines>) {
        if let Some(old) = self.files.remove(path) {
            self.count(&old.origins, -1);
        }
        if let Some(file) = file {
            self.count(&file.origins, 1);
            self.files.insert(path.to_owned(), file);
        }
    }

    fn fallback(&mut self, reason: &str) {
        *self.fallbacks.entry(reason.to_owned()).or_default() += 1;
    }

    fn levels(&self) -> (u64, u64, Vec<(Vec<u32>, u64)>) {
        let mut total = 0;
        let mut coauthored = 0;
        let mut groups = Vec::new();
        for (group, lines) in self.group_lines.iter().enumerate() {
            if *lines <= 0 {
                continue;
            }
            let lines = *lines as u64;
            let ids = &self.groups[group];
            total += lines;
            if ids.len() > 1 {
                coauthored += lines;
            }
            groups.push((ids.clone(), lines));
        }
        (total, coauthored, groups)
    }

    /// Surviving lines per origin commit, for comparison with a full blame scan.
    #[cfg(test)]
    pub fn origin_lines(&self) -> BTreeMap<String, u64> {
        let mut counts = BTreeMap::new();
        for file in self.files.values() {
            for origin in &file.origins {
                *counts
                    .entry(self.origins[*origin as usize].clone())
                    .or_default() += 1;
            }
        }
        counts
    }

    /// Raw attribution as identity tuples: what the HEAD scan's credits describe.
    pub fn final_state(&self) -> FinalState {
        let (total_lines, _, groups) = self.levels();
        FinalState {
            total_lines,
            groups: groups
                .into_iter()
                .map(|(ids, lines)| {
                    (
                        ids.iter()
                            .map(|id| {
                                let p = &self.identities[*id as usize];
                                (p.name.clone(), p.email.clone())
                            })
                            .collect(),
                        lines,
                    )
                })
                .collect(),
        }
    }
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PointV2 {
    pub revision: String,
    pub committed_at: String,
    pub total_lines: u64,
    pub coauthored_lines: u64,
    pub groups: Vec<(Vec<u32>, u64)>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FinalState {
    pub total_lines: u64,
    pub groups: Vec<(Vec<(String, String)>, u64)>,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HistoryBatchV2 {
    pub needs_reset: bool,
    pub identities: Vec<(u32, String, String)>,
    pub points: Vec<PointV2>,
    pub cursor: Option<String>,
    pub checkpoint_ref: Option<String>,
    pub done: bool,
    pub completed: usize,
    pub total: usize,
    #[serde(rename = "final")]
    pub final_state: Option<FinalState>,
    pub engine: Option<Engine>,
    pub fallbacks: BTreeMap<String, u64>,
}

/// One repository's walk: the state, the first-parent schedule built once, and
/// where the walk is in it.
pub struct Job {
    pub state: HistoryState,
    schedule: Vec<WalkCommit>,
    position: usize,
    coauthors: HashMap<String, Vec<Identity>>,
    pub checkpoint_ref: Option<String>,
}

fn git_bytes(repo: &Path, args: &[&str], cancelled: &AtomicBool) -> Result<Vec<u8>, String> {
    process::output(git_command(repo, args), cancelled)
}

fn git_string(repo: &Path, args: &[&str], cancelled: &AtomicBool) -> Result<String, String> {
    git_bytes(repo, args, cancelled).map(|b| String::from_utf8_lossy(&b).into_owned())
}

fn lower_email(email: &str) -> String {
    email
        .trim()
        .trim_start_matches('<')
        .trim_end_matches('>')
        .to_lowercase()
}

/// Blob of `.mailmap` at the target; it decides every identity, so a change rebuilds.
pub fn mailmap_blob(repo: &Path, target: &str, cancelled: &AtomicBool) -> Result<String, String> {
    match git_string(
        repo,
        &["rev-parse", "--verify", "-q", &format!("{target}:.mailmap")],
        cancelled,
    ) {
        Ok(sha) => Ok(sha.trim().to_owned()),
        Err(_) => {
            check_cancel(cancelled)?;
            Ok(String::new())
        }
    }
}

/// First-parent commits after `from`, oldest first, with parents, times and mailmapped authors.
pub fn schedule(
    repo: &Path,
    from: Option<&str>,
    target: &str,
    cancelled: &AtomicBool,
) -> Result<Vec<WalkCommit>, String> {
    let range = match from {
        Some(from) => format!("{from}..{target}"),
        None => target.to_owned(),
    };
    let log = git_string(
        repo,
        &[
            "log",
            "--first-parent",
            "--reverse",
            "--format=%H%x1f%P%x1f%ct%x1f%cI%x1f%aN%x1f%aE",
            &range,
            "--",
        ],
        cancelled,
    )?;
    let mut commits = Vec::new();
    for line in log.lines().filter(|l| !l.is_empty()) {
        let parts: Vec<_> = line.split('\u{1f}').collect();
        if parts.len() != 6 || !is_commit_id(parts[0]) {
            return Err("Invalid ownership history line".into());
        }
        commits.push(WalkCommit {
            sha: parts[0].to_owned(),
            parents: parts[1].split_whitespace().map(str::to_owned).collect(),
            unix: parts[2].trim().parse().map_err(|_| "Invalid commit time")?,
            committed_at: parts[3].to_owned(),
            author: Identity {
                name: parts[4].to_owned(),
                email: lower_email(parts[5]),
            },
        });
    }
    Ok(commits)
}

/// Set up a walk, or `None` when the checkpoint cannot continue to this target.
pub fn prepare_job(
    repo: &Path,
    options: &ScanOptions,
    target: &str,
    engine: Engine,
    generation: i64,
    previous: Option<HistoryState>,
    cancelled: &AtomicBool,
) -> Result<Option<Job>, String> {
    let mailmap = mailmap_blob(repo, target, cancelled)?;
    let mut state = match previous {
        Some(state) => {
            if state.engine != engine
                || state.generation != generation
                || state.options_hash != options_hash(options)
                || state.mailmap != mailmap
            {
                return Ok(None);
            }
            state
        }
        None => HistoryState::fresh(engine, generation, options, mailmap),
    };
    let schedule = match state.cursor.as_deref() {
        Some(cursor) if cursor == target => Vec::new(),
        Some(cursor) => {
            let commits = schedule(repo, Some(cursor), target, cancelled)?;
            if commits.first().and_then(|c| c.parents.first()).map(String::as_str) != Some(cursor) {
                // Force-pushed or rewritten: the cursor is not the first parent of what follows.
                return Ok(None);
            }
            commits
        }
        None => schedule(repo, None, target, cancelled)?,
    };
    state.target = target.to_owned();
    Ok(Some(Job {
        state,
        schedule,
        position: 0,
        coauthors: HashMap::new(),
        checkpoint_ref: None,
    }))
}

#[derive(Debug, Clone, Default)]
struct Hunk {
    old_start: usize,
    old_count: usize,
    new_start: usize,
    new_count: usize,
}

#[derive(Debug, Clone)]
struct RawChange {
    old_mode: String,
    new_mode: String,
    old_blob: String,
    new_blob: String,
    /// Similarity of a rename, 0–100.
    score: u32,
    status: char,
    path: String,
    /// The source path of a rename.
    old_path: Option<String>,
}

#[derive(Debug, Default)]
struct CommitChanges {
    sha: String,
    raw: Vec<RawChange>,
    /// Patch hunks per path. A path with a `Binary files` marker is in `binary`.
    hunks: HashMap<String, Vec<Hunk>>,
    binary: BTreeSet<String>,
}

/// Undo Git's C-style path quoting.
fn unquote(path: &str) -> Result<String, String> {
    let Some(inner) = path.strip_prefix('"').and_then(|p| p.strip_suffix('"')) else {
        return Ok(path.to_owned());
    };
    let mut out = Vec::new();
    let bytes = inner.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'\\' {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        i += 1;
        let c = *bytes.get(i).ok_or("Invalid quoted path")?;
        match c {
            b'n' => out.push(b'\n'),
            b't' => out.push(b'\t'),
            b'r' => out.push(b'\r'),
            b'a' => out.push(7),
            b'b' => out.push(8),
            b'f' => out.push(12),
            b'v' => out.push(11),
            b'"' | b'\\' => out.push(c),
            b'0'..=b'7' => {
                let digits = bytes.get(i..i + 3).ok_or("Invalid quoted path")?;
                let text = std::str::from_utf8(digits).map_err(|_| "Invalid quoted path")?;
                out.push(u8::from_str_radix(text, 8).map_err(|_| "Invalid quoted path")?);
                i += 2;
            }
            _ => return Err("Invalid quoted path".into()),
        }
        i += 1;
    }
    String::from_utf8(out)
        .map_err(|_| "A tracked filename is not valid UTF-8; cannot scan it accurately.".into())
}

fn parse_range(text: &str) -> Result<(usize, usize), String> {
    let (start, count) = match text.split_once(',') {
        Some((s, c)) => (s, c),
        None => (text, "1"),
    };
    Ok((
        start.parse().map_err(|_| "Invalid hunk header")?,
        count.parse().map_err(|_| "Invalid hunk header")?,
    ))
}

/// The path in `diff --git a/X b/Y`, taken from the `b/` side.
fn patch_path(line: &str) -> Result<String, String> {
    let rest = line.strip_prefix("diff --git ").ok_or("Invalid patch header")?;
    // Both sides share quoting and, except for a rename, the same path. A rename's
    // destination comes from its `rename to` line instead.
    if rest.starts_with('"') {
        let mut end = 1;
        let bytes = rest.as_bytes();
        while end < bytes.len() {
            if bytes[end] == b'\\' {
                end += 2;
                continue;
            }
            if bytes[end] == b'"' {
                break;
            }
            end += 1;
        }
        let a = unquote(&rest[..=end.min(rest.len() - 1)])?;
        return Ok(a.strip_prefix("a/").unwrap_or(&a).to_owned());
    }
    let half = (rest.len() - 1) / 2;
    // Unequal halves only happen for a rename, whose `rename to` line replaces this.
    let a = rest.get(..half).unwrap_or("");
    Ok(a.strip_prefix("a/").unwrap_or(a).to_owned())
}

/// Stream raw changes and `-U0 -w` hunk headers for a range, one entry per commit.
/// Line contents are discarded as they are read.
fn read_changes(
    repo: &Path,
    range: &str,
    with_patch: bool,
    cancelled: &AtomicBool,
) -> Result<Vec<CommitChanges>, String> {
    read_log(repo, &["--first-parent", "-m", "--reverse"], &[range, "--"], with_patch, cancelled)
}

fn read_log(
    repo: &Path,
    walk: &[&str],
    tail: &[&str],
    with_patch: bool,
    cancelled: &AtomicBool,
) -> Result<Vec<CommitChanges>, String> {
    let mut args: Vec<&str> = DIFF_CONFIG.to_vec();
    args.extend(["-c", "core.quotePath=false", "log"]);
    args.extend_from_slice(walk);
    args.extend([
        "--raw",
        "--no-abbrev",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--format=%x01%H",
    ]);
    if with_patch {
        // Blame follows a whole-file rename by running the same rename detection
        // over the commit, with the default limit. Replay applies the rename's
        // own diff to the source's origins, exactly as blame passes lines back.
        args.extend(["-M", "-l1000", "-p", "-U0", "-w", "--diff-algorithm=myers", "--indent-heuristic"]);
    } else {
        args.push("--no-renames");
    }
    args.extend_from_slice(tail);
    process::stream(git_command(repo, &args), &[], cancelled, |reader| {
        let mut commits: Vec<CommitChanges> = Vec::new();
        let mut path: Option<String> = None;
        let mut pending_old = 0usize;
        let mut pending_new = 0usize;
        let mut bytes = Vec::new();
        let mut seen = 0usize;
        loop {
            bytes.clear();
            if reader.read_until(b'\n', &mut bytes).map_err(|e| e.to_string())? == 0 {
                break;
            }
            seen += 1;
            if seen % 4096 == 0 {
                check_cancel(cancelled)?;
            }
            let end = bytes
                .iter()
                .rposition(|b| *b != b'\n' && *b != b'\r')
                .map_or(0, |i| i + 1);
            let line = &bytes[..end];
            if pending_old + pending_new > 0 {
                match line.first() {
                    Some(b'-') => pending_old = pending_old.saturating_sub(1),
                    Some(b'+') => pending_new = pending_new.saturating_sub(1),
                    Some(b'\\') => {}
                    _ => return Err("Patch hunk ended early".into()),
                }
                continue;
            }
            if line.first() == Some(&b'\\') {
                continue;
            }
            let text = std::str::from_utf8(line).map_err(|_| {
                "A tracked filename is not valid UTF-8; cannot scan it accurately.".to_string()
            })?;
            if let Some(sha) = text.strip_prefix('\u{1}') {
                commits.push(CommitChanges {
                    sha: sha.trim().to_owned(),
                    ..Default::default()
                });
                path = None;
                continue;
            }
            let Some(commit) = commits.last_mut() else {
                continue;
            };
            if let Some(rest) = text.strip_prefix(':') {
                let (meta, raw_path) = rest.split_once('\t').ok_or("Invalid raw diff line")?;
                let fields: Vec<_> = meta.split_whitespace().collect();
                if fields.len() != 5 {
                    return Err("Invalid raw diff line".into());
                }
                let status = fields[4].chars().next().unwrap_or('M');
                let (old_path, new_path) = if status == 'R' || status == 'C' {
                    let (from, to) = raw_path.split_once('\t').ok_or("Invalid rename line")?;
                    (Some(unquote(from)?), unquote(to)?)
                } else {
                    (None, unquote(raw_path)?)
                };
                commit.raw.push(RawChange {
                    old_mode: fields[0].to_owned(),
                    new_mode: fields[1].to_owned(),
                    old_blob: fields[2].to_owned(),
                    new_blob: fields[3].to_owned(),
                    score: fields[4][1..].parse().unwrap_or(0),
                    status,
                    path: new_path,
                    old_path,
                });
            } else if text.starts_with("diff --git ") {
                path = Some(patch_path(text)?);
            } else if let Some(to) = text.strip_prefix("rename to ") {
                path = Some(unquote(to)?);
            } else if let Some(header) = text.strip_prefix("@@ -") {
                let current = path.clone().ok_or("Hunk without a file")?;
                let (old, rest) = header.split_once(" +").ok_or("Invalid hunk header")?;
                let new = rest.split_once(" @@").map_or(rest, |(n, _)| n);
                let (old_start, old_count) = parse_range(old)?;
                let (new_start, new_count) = parse_range(new)?;
                pending_old = old_count;
                pending_new = new_count;
                commit.hunks.entry(current).or_default().push(Hunk {
                    old_start,
                    old_count,
                    new_start,
                    new_count,
                });
            } else if text.starts_with("Binary files ") || text == "GIT binary patch" {
                if let Some(current) = &path {
                    commit.binary.insert(current.clone());
                }
            }
        }
        Ok(commits)
    })
}

/// Commit bodies for co-author trailers, one process per chunk.
fn read_coauthors(
    repo: &Path,
    shas: &[&str],
    cancelled: &AtomicBool,
    out: &mut HashMap<String, Vec<Identity>>,
) -> Result<(), String> {
    for chunk in shas.chunks(200) {
        check_cancel(cancelled)?;
        let mut args = vec!["log", "--no-walk", "--format=%H%x00%B%x00"];
        args.extend_from_slice(chunk);
        args.push("--");
        let log = git_string(repo, &args, cancelled)?;
        let mut fields = log.split('\0');
        while let (Some(sha), Some(body)) = (fields.next(), fields.next()) {
            out.insert(sha.trim().to_owned(), parse_coauthors(body));
        }
    }
    Ok(())
}

/// Positional blame: the origin commit of every line, with each origin's author.
fn blame_lines(
    repo: &Path,
    revision: &str,
    path: &str,
    cancelled: &AtomicBool,
) -> Result<(Vec<String>, HashMap<String, Identity>), String> {
    let mut args: Vec<&str> = DIFF_CONFIG.to_vec();
    args.extend(["blame", "--incremental", "--encoding=utf-8", "-w", revision, "--", path]);
    process::stream(git_command(repo, &args), &[], cancelled, |reader| {
        let mut lines: Vec<Option<String>> = Vec::new();
        let mut authors = HashMap::<String, Identity>::new();
        let mut sha = String::new();
        let mut bytes = Vec::new();
        loop {
            bytes.clear();
            if reader.read_until(b'\n', &mut bytes).map_err(|e| e.to_string())? == 0 {
                break;
            }
            let line = String::from_utf8_lossy(&bytes);
            let line = line.trim_end_matches(['\r', '\n']);
            let mut fields = line.split_whitespace();
            if let Some(token) = fields.next() {
                if is_commit_id(token) {
                    let _source = fields.next();
                    let start: usize = fields
                        .next()
                        .and_then(|v| v.parse().ok())
                        .ok_or("Invalid blame group")?;
                    let count: usize = fields
                        .next()
                        .and_then(|v| v.parse().ok())
                        .ok_or("Invalid blame group size")?;
                    if start == 0 {
                        return Err("Invalid blame line number".into());
                    }
                    if lines.len() < start - 1 + count {
                        lines.resize(start - 1 + count, None);
                    }
                    for slot in &mut lines[start - 1..start - 1 + count] {
                        *slot = Some(token.to_owned());
                    }
                    sha = token.to_owned();
                    authors.entry(sha.clone()).or_default();
                    continue;
                }
            }
            if sha.is_empty() {
                continue;
            }
            if let Some(name) = line.strip_prefix("author ") {
                authors.entry(sha.clone()).or_default().name = name.to_owned();
            } else if let Some(email) = line.strip_prefix("author-mail ") {
                authors.entry(sha.clone()).or_default().email = lower_email(email);
            }
        }
        let lines = lines
            .into_iter()
            .map(|line| line.ok_or_else(|| "Blame left a line unattributed".to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        Ok((lines, authors))
    })
}

fn is_regular(mode: &str) -> bool {
    mode == "100644" || mode == "100755"
}

/// The same exclusions as the HEAD scan: generated, excluded and binary-extension paths.
pub struct Classifier {
    patterns: Vec<glob::Pattern>,
}

impl Classifier {
    pub fn new(options: &ScanOptions) -> Result<Self, String> {
        let patterns = GENERATED
            .iter()
            .filter(|_| !options.include_generated)
            .copied()
            .chain(options.excludes.iter().map(String::as_str))
            .map(|p| glob::Pattern::new(p).map_err(|e| format!("Invalid exclude pattern {p}: {e}")))
            .collect::<Result<_, _>>()?;
        Ok(Classifier { patterns })
    }

    fn included(&self, path: &str, mode: &str) -> bool {
        if !is_regular(mode) {
            return false;
        }
        let file = Path::new(path);
        let basename = file.file_name().and_then(|p| p.to_str()).unwrap_or(path);
        let suffix = file
            .extension()
            .and_then(|p| p.to_str())
            .unwrap_or("")
            .to_lowercase();
        !(self.patterns.iter().any(|p| p.matches(path) || p.matches(basename))
            || BINARY.contains(&suffix.as_str()))
    }
}

/// Replace `old`'s changed ranges with lines from `origin`. `None` when the hunks
/// do not line up with the file, in which case the caller re-blames.
fn apply_hunks(old: &[u32], hunks: &[Hunk], origin: u32) -> Option<Vec<u32>> {
    let mut out = Vec::with_capacity(old.len() + hunks.iter().map(|h| h.new_count).sum::<usize>());
    let mut pos = 0;
    for hunk in hunks {
        let start = if hunk.old_count == 0 {
            hunk.old_start
        } else {
            hunk.old_start.checked_sub(1)?
        };
        if start < pos || start > old.len() || start + hunk.old_count > old.len() {
            return None;
        }
        out.extend_from_slice(&old[pos..start]);
        let expected = if hunk.new_count == 0 {
            hunk.new_start
        } else {
            hunk.new_start.checked_sub(1)?
        };
        if out.len() != expected {
            return None;
        }
        out.extend(std::iter::repeat_n(origin, hunk.new_count));
        pos = start + hunk.old_count;
    }
    out.extend_from_slice(&old[pos..]);
    Some(out)
}

pub struct BatchLimits {
    pub time_budget: Duration,
    pub max_commits: usize,
    pub chunk: usize,
    pub workers: usize,
}

impl Default for BatchLimits {
    fn default() -> Self {
        BatchLimits {
            time_budget: Duration::from_secs(3),
            max_commits: 2000,
            chunk: 100,
            workers: 1,
        }
    }
}

/// Advance the walk by up to one time budget. Returns the batch without a checkpoint reference.
pub fn run_batch(
    job: &mut Job,
    repo: &Path,
    options: &ScanOptions,
    limits: &BatchLimits,
    cancelled: &AtomicBool,
    progress: impl Fn(usize, usize),
) -> Result<HistoryBatchV2, String> {
    let classifier = Classifier::new(options)?;
    let started = Instant::now();
    let total = job.state.applied + job.schedule.len() - job.position;
    let mut candidates: BTreeMap<i64, (i64, String, PointV2)> = BTreeMap::new();
    let mut processed = 0;
    while job.position < job.schedule.len()
        && processed < limits.max_commits
        && (processed == 0 || started.elapsed() < limits.time_budget)
    {
        check_cancel(cancelled)?;
        let end = (job.position + limits.chunk.max(1)).min(job.schedule.len());
        let range = match job.position.checked_sub(1).map(|i| job.schedule[i].sha.clone()).or_else(|| job.state.cursor.clone()) {
            Some(from) => format!("{from}..{}", job.schedule[end - 1].sha),
            None => job.schedule[end - 1].sha.clone(),
        };
        let mut changes = read_changes(repo, &range, job.state.engine == Engine::Replay, cancelled)?;
        let slice: Vec<WalkCommit> = job.schedule[job.position..end].to_vec();
        if job.state.engine == Engine::Replay && slice.iter().any(|c| c.parents.len() > 1) {
            // `-w` drops files whose change is whitespace-only. At a merge, blame
            // hands a file wholly to any parent it is identical to, so a merge
            // needs every file whose bytes differ from the first parent.
            let exact = read_changes(repo, &range, false, cancelled)?;
            if exact.len() != changes.len() {
                return Err("Ownership history changed while it was read".into());
            }
            for ((commit, change), plain) in slice.iter().zip(&mut changes).zip(exact) {
                if commit.parents.len() > 1 && plain.sha == change.sha {
                    change.raw = plain.raw;
                    change.hunks.clear();
                    change.binary.clear();
                }
            }
        }
        if changes.len() != slice.len() || changes.iter().zip(&slice).any(|(c, s)| c.sha != s.sha) {
            return Err("Ownership history changed while it was read".into());
        }
        let unknown: Vec<&str> = slice
            .iter()
            .map(|c| c.sha.as_str())
            .filter(|sha| !job.coauthors.contains_key(*sha))
            .collect();
        read_coauthors(repo, &unknown, cancelled, &mut job.coauthors)?;
        let mut blobs: Vec<&str> = changes
            .iter()
            .flat_map(|c| &c.raw)
            .filter(|r| r.status != 'D' && classifier.included(&r.path, &r.new_mode))
            .map(|r| r.new_blob.as_str())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        blobs.retain(|b| !b.bytes().all(|c| c == b'0'));
        let flags = binary_blobs(repo, &blobs, cancelled)?;
        let binary: HashMap<&str, bool> = blobs.iter().copied().zip(flags).collect();
        for (commit, change) in slice.iter().zip(&changes) {
            check_cancel(cancelled)?;
            apply_commit(job, repo, commit, change, &classifier, &binary, limits.workers, cancelled)?;
            job.position += 1;
            job.state.applied += 1;
            job.state.cursor = Some(commit.sha.clone());
            processed += 1;
            let day = commit.unix.div_euclid(86_400);
            let beats = job
                .state
                .day_best
                .get(&day)
                .is_none_or(|(unix, sha)| (commit.unix, commit.sha.as_str()) > (*unix, sha.as_str()));
            if beats {
                job.state.day_best.insert(day, (commit.unix, commit.sha.clone()));
                let (total_lines, coauthored_lines, groups) = job.state.levels();
                candidates.insert(
                    day,
                    (
                        commit.unix,
                        commit.sha.clone(),
                        PointV2 {
                            revision: commit.sha.clone(),
                            committed_at: commit.committed_at.clone(),
                            total_lines,
                            coauthored_lines,
                            groups,
                        },
                    ),
                );
            }
        }
        progress(job.state.applied, total);
    }
    let done = job.position == job.schedule.len();
    let identities = job.state.identities[job.state.emitted_identities..]
        .iter()
        .enumerate()
        .map(|(i, p)| ((job.state.emitted_identities + i) as u32, p.name.clone(), p.email.clone()))
        .collect();
    job.state.emitted_identities = job.state.identities.len();
    Ok(HistoryBatchV2 {
        needs_reset: false,
        identities,
        points: candidates.into_values().map(|(_, _, point)| point).collect(),
        cursor: job.state.cursor.clone(),
        checkpoint_ref: None,
        done,
        completed: job.state.applied,
        total,
        final_state: done.then(|| job.state.final_state()),
        engine: Some(job.state.engine),
        fallbacks: job.state.fallbacks.clone(),
    })
}

#[allow(clippy::too_many_arguments)]
fn apply_commit(
    job: &mut Job,
    repo: &Path,
    commit: &WalkCommit,
    change: &CommitChanges,
    classifier: &Classifier,
    binary: &HashMap<&str, bool>,
    workers: usize,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let merge = commit.parents.len() > 1;
    let replay = job.state.engine == Engine::Replay;
    // Everything this commit removes, with its origins as they were: blame can
    // take a new path's lines from any deleted file, not only the one `-M` paired.
    let mut removed: HashMap<String, (String, Vec<u32>)> = HashMap::new();
    for raw in &change.raw {
        let source = if raw.status == 'D' { Some(&raw.path) } else { raw.old_path.as_ref() };
        if let Some(source) = source {
            if let Some(file) = job.state.files.get(source) {
                removed.insert(source.clone(), (raw.old_blob.clone(), file.origins.clone()));
            }
        }
    }
    for path in removed.keys() {
        job.state.replace_file(path, None);
    }
    let is_text = |raw: &RawChange| {
        raw.status != 'D'
            && classifier.included(&raw.path, &raw.new_mode)
            && !binary.get(raw.new_blob.as_str()).copied().unwrap_or(false)
    };
    // Blame looks for each new path's rename source on its own; full `-M`
    // detection lets a deleted file go to one new path only. They can differ
    // only when a source was taken by another path (the commit has rename
    // pairs) or git skipped inexact detection for size. Then blame decides,
    // except for an exact rename from a unique blob, which pairs the same way.
    let dests = change.raw.iter().filter(|r| (r.status == 'A' || r.status == 'R') && is_text(r)).count();
    let contested = replay
        && !plain_rename_pairing()
        && !merge
        && !removed.is_empty()
        && (change.raw.iter().any(|r| r.status == 'R') || removed.len().saturating_mul(dests) > 1_000_000);
    let blob_count = |blob: &str| removed.values().filter(|(b, _)| b == blob).count();
    let mut reblame: Vec<(String, String, &'static str)> = Vec::new();
    for raw in change.raw.iter().filter(|r| r.status != 'D') {
        if !is_text(raw) {
            // Excluded, a symlink or submodule now, or binary content: no lines.
            job.state.replace_file(&raw.path, None);
            continue;
        }
        if contested
            && (raw.status == 'A' || raw.status == 'R')
            && !(raw.status == 'R' && raw.score == 100 && blob_count(&raw.old_blob) == 1)
        {
            reblame.push((raw.path.clone(), raw.new_blob.clone(), "rename"));
            continue;
        }
        let status = raw.status;
        let source = raw.old_path.clone();
        let hunks = change.hunks.get(&raw.path).map_or(&[][..], Vec::as_slice);
        let binary_patch = change.binary.contains(&raw.path);
        let reason = if !replay {
            Some("blame")
        } else if merge {
            Some("merge")
        } else if binary_patch {
            Some("attributes")
        } else if status == 'C' {
            Some("copy")
        } else if let Some(source) = &source {
            // A source that was binary, excluded or not a regular file.
            (!removed.contains_key(source)).then_some("transition")
        } else if status == 'A' {
            None
        } else if !job.state.files.contains_key(&raw.path) || !is_regular(&raw.old_mode) {
            // Was binary or not a regular file: blame can still match old lines.
            Some("transition")
        } else {
            None
        };
        if let Some(reason) = reason {
            reblame.push((raw.path.clone(), raw.new_blob.clone(), reason));
            continue;
        }
        let origin = job.state.add_origin(
            &commit.sha,
            &commit.author,
            job.coauthors.get(&commit.sha).map_or(&[][..], Vec::as_slice),
        );
        let old = match &source {
            Some(source) => removed.get(source).map_or(&[][..], |(_, o)| o.as_slice()),
            None if status == 'A' => &[][..],
            None => job.state.files.get(&raw.path).map_or(&[][..], |f| f.origins.as_slice()),
        };
        match apply_hunks(old, hunks, origin) {
            Some(origins) => job.state.replace_file(
                &raw.path,
                Some(FileLines {
                    blob: raw.new_blob.clone(),
                    origins,
                }),
            ),
            None => reblame.push((raw.path.clone(), raw.new_blob.clone(), "hunk")),
        }
    }
    if reblame.is_empty() {
        return Ok(());
    }
    for (_, _, reason) in &reblame {
        if replay {
            job.state.fallback(reason);
        }
    }
    let results = blame_parallel(repo, &commit.sha, &reblame, workers, cancelled)?;
    let mut unknown = BTreeSet::new();
    for (_, (lines, _)) in &results {
        for sha in lines {
            if job.state.origin(sha).is_none() && !job.coauthors.contains_key(sha) {
                unknown.insert(sha.clone());
            }
        }
    }
    let unknown: Vec<&str> = unknown.iter().map(String::as_str).collect();
    read_coauthors(repo, &unknown, cancelled, &mut job.coauthors)?;
    for ((path, blob, _), (_, (lines, authors))) in reblame.iter().zip(results) {
        let mut origins = Vec::with_capacity(lines.len());
        for sha in &lines {
            let origin = match job.state.origin(sha) {
                Some(origin) => origin,
                None => {
                    let author = authors.get(sha).cloned().unwrap_or_default();
                    let coauthors = job.coauthors.get(sha).cloned().unwrap_or_default();
                    job.state.add_origin(sha, &author, &coauthors)
                }
            };
            origins.push(origin);
        }
        job.state.replace_file(
            path,
            Some(FileLines {
                blob: blob.clone(),
                origins,
            }),
        );
    }
    Ok(())
}

type BlameResult = (Vec<String>, HashMap<String, Identity>);

/// Blame several files at one commit on a bounded number of threads, keeping input order.
fn blame_parallel(
    repo: &Path,
    revision: &str,
    files: &[(String, String, &'static str)],
    workers: usize,
    cancelled: &AtomicBool,
) -> Result<Vec<(String, BlameResult)>, String> {
    let results = parallel(files, workers, |(path, _, _)| {
        blame_lines(repo, revision, path, cancelled).map_err(|e| format!("Cannot blame {path}: {e}"))
    })?;
    Ok(files.iter().map(|(path, _, _)| path.clone()).zip(results).collect())
}

/// Run `work` over `items` on up to `workers` threads, returning results in input
/// order, or the first error in input order.
fn parallel<I: Sync, T: Send>(
    items: &[I],
    workers: usize,
    work: impl Fn(&I) -> Result<T, String> + Sync,
) -> Result<Vec<T>, String> {
    let next = AtomicUsize::new(0);
    let results: Vec<std::sync::Mutex<Option<Result<T, String>>>> =
        items.iter().map(|_| std::sync::Mutex::new(None)).collect();
    std::thread::scope(|scope| {
        for _ in 0..workers.max(1).min(items.len()) {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, Ordering::Relaxed);
                let Some(item) = items.get(index) else {
                    break;
                };
                let result = work(item);
                if let Ok(mut slot) = results[index].lock() {
                    *slot = Some(result);
                }
            });
        }
    });
    results
        .into_iter()
        .map(|slot| {
            slot.into_inner()
                .map_err(|_| "Worker failed".to_string())?
                .ok_or_else(|| "Worker did not finish".to_string())?
        })
        .collect()
}

/* ── Native checkpoint ─────────────────────────────────────────────────────── */

#[derive(Serialize, Deserialize)]
struct StoredFile {
    blob: String,
    /// Run-length encoded origins: consecutive lines usually share one.
    runs: Vec<(u32, u32)>,
}

#[derive(Serialize, Deserialize)]
struct StoredState {
    engine: Engine,
    generation: i64,
    options_hash: String,
    mailmap: String,
    target: String,
    cursor: Option<String>,
    applied: usize,
    identities: Vec<Identity>,
    emitted_identities: usize,
    origins: Vec<String>,
    origin_group: Vec<u32>,
    groups: Vec<Vec<u32>>,
    files: BTreeMap<String, StoredFile>,
    day_best: Vec<(i64, i64, String)>,
    fallbacks: BTreeMap<String, u64>,
}

#[derive(Serialize, Deserialize)]
struct CheckpointHeader {
    format_version: u32,
    history_format: u32,
    engine: Engine,
    generation: i64,
    target: String,
    cursor: Option<String>,
    options_hash: String,
    checksum: String,
}

fn encode_runs(origins: &[u32]) -> Vec<(u32, u32)> {
    let mut runs: Vec<(u32, u32)> = Vec::new();
    for origin in origins {
        match runs.last_mut() {
            Some((last, count)) if last == origin => *count += 1,
            _ => runs.push((*origin, 1)),
        }
    }
    runs
}

impl HistoryState {
    fn to_stored(&self) -> StoredState {
        StoredState {
            engine: self.engine,
            generation: self.generation,
            options_hash: self.options_hash.clone(),
            mailmap: self.mailmap.clone(),
            target: self.target.clone(),
            cursor: self.cursor.clone(),
            applied: self.applied,
            identities: self.identities.clone(),
            emitted_identities: self.emitted_identities,
            origins: self.origins.clone(),
            origin_group: self.origin_group.clone(),
            groups: self.groups.clone(),
            files: self
                .files
                .iter()
                .map(|(path, file)| {
                    (
                        path.clone(),
                        StoredFile {
                            blob: file.blob.clone(),
                            runs: encode_runs(&file.origins),
                        },
                    )
                })
                .collect(),
            day_best: self
                .day_best
                .iter()
                .map(|(day, (unix, sha))| (*day, *unix, sha.clone()))
                .collect(),
            fallbacks: self.fallbacks.clone(),
        }
    }

    fn from_stored(stored: StoredState) -> Result<Self, String> {
        let bad = || "Ownership history checkpoint is corrupt".to_string();
        let mut state = HistoryState {
            engine: stored.engine,
            generation: stored.generation,
            options_hash: stored.options_hash,
            mailmap: stored.mailmap,
            target: stored.target,
            cursor: stored.cursor,
            applied: stored.applied,
            identity_index: stored
                .identities
                .iter()
                .enumerate()
                .map(|(i, p)| (p.clone(), i as u32))
                .collect(),
            identities: stored.identities,
            emitted_identities: stored.emitted_identities,
            origin_index: stored
                .origins
                .iter()
                .enumerate()
                .map(|(i, sha)| (sha.clone(), i as u32))
                .collect(),
            origins: stored.origins,
            origin_group: stored.origin_group,
            group_index: stored
                .groups
                .iter()
                .enumerate()
                .map(|(i, ids)| (ids.clone(), i as u32))
                .collect(),
            group_lines: vec![0; stored.groups.len()],
            groups: stored.groups,
            files: BTreeMap::new(),
            day_best: stored
                .day_best
                .into_iter()
                .map(|(day, unix, sha)| (day, (unix, sha)))
                .collect(),
            fallbacks: stored.fallbacks,
        };
        if state.origin_group.len() != state.origins.len()
            || state.emitted_identities > state.identities.len()
            || state
                .groups
                .iter()
                .flatten()
                .any(|id| *id as usize >= state.identities.len())
            || state
                .origin_group
                .iter()
                .any(|g| *g as usize >= state.groups.len())
        {
            return Err(bad());
        }
        for (path, file) in stored.files {
            let mut origins = Vec::new();
            for (origin, count) in file.runs {
                if origin as usize >= state.origins.len() {
                    return Err(bad());
                }
                origins.extend(std::iter::repeat_n(origin, count as usize));
            }
            state.count(&origins, 1);
            state.files.insert(
                path,
                FileLines {
                    blob: file.blob,
                    origins,
                },
            );
        }
        Ok(state)
    }
}

/// Where one repository's history checkpoints live.
pub fn checkpoint_dir(cache: &Path, github_repo: &str) -> PathBuf {
    cache
        .join("checkpoints")
        .join(github_repo.to_lowercase().replace('/', "__"))
}

fn valid_ref(name: &str) -> bool {
    !name.is_empty()
        && name.len() < 200
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        && !name.starts_with('.')
}

/// Write the checkpoint to a temporary file, flush it, and rename it into place.
/// Names are never reused, so the previous checkpoint stays valid until the
/// database points past it.
pub fn write_checkpoint(dir: &Path, state: &HistoryState) -> Result<String, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let body = serde_json::to_vec(&state.to_stored()).map_err(|e| e.to_string())?;
    let header = CheckpointHeader {
        format_version: CHECKPOINT_FORMAT,
        history_format: HISTORY_FORMAT,
        engine: state.engine,
        generation: state.generation,
        target: state.target.clone(),
        cursor: state.cursor.clone(),
        options_hash: state.options_hash.clone(),
        checksum: format!("{:016x}", fnv1a(&body)),
    };
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let cursor = state.cursor.as_deref().unwrap_or("root");
    let name = format!(
        "g{}-{:?}-{}-{nanos}.ckpt",
        state.generation,
        state.engine,
        &cursor[..cursor.len().min(12)]
    )
    .to_lowercase();
    let temp = dir.join(format!(".{name}.tmp"));
    {
        let mut file = std::fs::File::create(&temp).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec(&header).map_err(|e| e.to_string())?)
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.write_all(&body))
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
    }
    std::fs::rename(&temp, dir.join(&name)).map_err(|e| e.to_string())?;
    Ok(name)
}

/// Load and validate a checkpoint. A mismatch or corruption is an explicit error.
pub fn read_checkpoint(dir: &Path, name: &str) -> Result<HistoryState, String> {
    if !valid_ref(name) {
        return Err("Invalid ownership history checkpoint name".into());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(dir.join(name))
        .and_then(|mut f| f.read_to_end(&mut bytes))
        .map_err(|e| format!("Ownership history checkpoint is missing: {e}"))?;
    let split = bytes
        .iter()
        .position(|b| *b == b'\n')
        .ok_or("Ownership history checkpoint is corrupt")?;
    let header: CheckpointHeader = serde_json::from_slice(&bytes[..split])
        .map_err(|_| "Ownership history checkpoint is corrupt")?;
    let body = &bytes[split + 1..];
    if header.format_version != CHECKPOINT_FORMAT || header.history_format != HISTORY_FORMAT {
        return Err("Ownership history checkpoint is from another version".into());
    }
    if header.checksum != format!("{:016x}", fnv1a(body)) {
        return Err("Ownership history checkpoint is corrupt".into());
    }
    let stored: StoredState =
        serde_json::from_slice(body).map_err(|_| "Ownership history checkpoint is corrupt")?;
    if stored.engine != header.engine
        || stored.generation != header.generation
        || stored.cursor != header.cursor
        || stored.options_hash != header.options_hash
    {
        return Err("Ownership history checkpoint is corrupt".into());
    }
    HistoryState::from_stored(stored)
}

/// Remove every checkpoint except `keep`, including orphans from a crash.
pub fn prune_checkpoints(dir: &Path, keep: &[&str]) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !keep.contains(&name.as_str()) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}
