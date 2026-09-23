//! Pipe-safe Git execution with cancellation, including streaming batch output.
use std::io::{BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

static SPAWNED: Mutex<BTreeMap<String, u64>> = Mutex::new(BTreeMap::new());

/// The Git subcommand a command runs, skipping `-C path` and `-c key=value`.
fn subcommand(command: &Command) -> String {
    let mut args = command.get_args().map(|a| a.to_string_lossy().into_owned());
    while let Some(arg) = args.next() {
        if arg == "-C" || arg == "-c" {
            args.next();
            continue;
        }
        return arg;
    }
    String::new()
}

/// Processes started per Git subcommand since the last reset, for benchmarks.
#[allow(dead_code)]
pub(super) fn spawned() -> BTreeMap<String, u64> {
    SPAWNED.lock().map(|m| m.clone()).unwrap_or_default()
}

#[allow(dead_code)]
pub(super) fn reset_spawned() {
    if let Ok(mut m) = SPAWNED.lock() {
        m.clear();
    }
}

pub(super) fn stream<T>(
    mut command: Command,
    input: &[u8],
    cancelled: &AtomicBool,
    read: impl FnOnce(&mut BufReader<std::process::ChildStdout>) -> Result<T, String>,
) -> Result<T, String> {
    super::check_cancel(cancelled)?;
    if let Ok(mut counts) = SPAWNED.lock() {
        *counts.entry(subcommand(&command)).or_default() += 1;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not run Git: {e}"))?;
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut stderr = child.stderr.take().unwrap();
    let failed = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let writer = scope.spawn(move || stdin.write_all(input));
        let errors = scope.spawn(move || {
            let mut bytes = Vec::new();
            stderr.read_to_end(&mut bytes).map(|_| bytes)
        });
        let watcher = scope.spawn(|| loop {
            if cancelled.load(Ordering::Relaxed) || failed.load(Ordering::Relaxed) {
                terminate(&mut child);
                return child.wait();
            }
            match child.try_wait() {
                Ok(Some(status)) => return Ok(status),
                Ok(None) => std::thread::sleep(Duration::from_millis(5)),
                Err(error) => {
                    terminate(&mut child);
                    let _ = child.wait();
                    return Err(error);
                }
            }
        });
        let result = read(&mut stdout);
        if result.is_err() {
            failed.store(true, Ordering::Relaxed);
        }
        // Drain to EOF even when a reader only needs a prefix, avoiding pipe deadlocks.
        if result.is_ok() && std::io::copy(&mut stdout, &mut std::io::sink()).is_err() {
            failed.store(true, Ordering::Relaxed);
        }
        let status = watcher
            .join()
            .map_err(|_| "Git watcher failed")?
            .map_err(|e| e.to_string())?;
        let written = writer.join().map_err(|_| "Git input writer failed")?;
        let errors = errors
            .join()
            .map_err(|_| "Git error reader failed")?
            .map_err(|e| e.to_string())?;
        super::check_cancel(cancelled)?;
        // Killing Git after a parse failure makes its status unsuccessful and
        // often leaves stderr empty. Keep the reader error in that case.
        let stderr = String::from_utf8_lossy(&errors).trim().to_owned();
        match result {
            Err(error) if status.success() || stderr.is_empty() => Err(error),
            Err(_) => Err(stderr),
            Ok(value) => {
                if !status.success() {
                    return Err(stderr);
                }
                written.map_err(|e| e.to_string())?;
                Ok(value)
            }
        }
    })
}

pub(super) fn output(command: Command, cancelled: &AtomicBool) -> Result<Vec<u8>, String> {
    stream(command, &[], cancelled, |reader| {
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        Ok(bytes)
    })
}

fn terminate(child: &mut std::process::Child) {
    // Git transports/index-pack inherit this isolated process group. Killing the
    // group prevents an orphan helper from keeping our pipes open after cancel.
    #[cfg(unix)]
    unsafe {
        unsafe extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }
        kill(-(child.id() as i32), 9);
    }
    let _ = child.kill();
}
