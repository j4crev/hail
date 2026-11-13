//! Backups, upgrades, rollback and restore for an installed provider.
//!
//! Every change of release or data follows the same shape: verify what will be
//! installed, stop the services that write to the database, take a backup, switch,
//! and on failure return to that backup.
use crate::backup::{self, Created, KEY, Manifest, Reason};
use crate::compose::Compose;
use crate::install::{configured, wait_ready};
use crate::s3::Remote;
use crate::state::{self, Answers, Env, Paths, RollbackPoint, State};
use crate::{release, ui};
use anyhow::{Context, Result, anyhow, bail, ensure};
use std::fs;
use std::path::{Path, PathBuf};

const DUMP: &str = "hail.dump";

fn answers(state: &State) -> Result<Answers> {
    state
        .answers
        .clone()
        .ok_or_else(|| anyhow!("hailctl.json has no answers"))
}

fn installed(state: &State) -> Result<String> {
    state
        .release
        .clone()
        .ok_or_else(|| anyhow!("no release is installed"))
}

fn key(paths: &Paths) -> Result<String> {
    Env::load(&paths.env())?
        .get(KEY)
        .map(str::to_string)
        .ok_or_else(|| anyhow!("{} has no {KEY}", paths.env().display()))
}

/// `YYYY-MM-DD HH:MM UTC`.
fn when(seconds: u64) -> String {
    let (y, mo, d, h, mi, _) = backup::utc(seconds);
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02} UTC")
}

/// Takes a backup, prunes old local copies and copies it off-host when configured.
/// Off-host failures fail manual and scheduled backups; before an upgrade, rollback or
/// restore the local copy is what matters, so they only warn.
fn take(paths: &Paths, state: &State, compose: &Compose, reason: Reason) -> Result<Created> {
    ui::info("Backing up the database...");
    let created = backup::create(paths, state, compose, reason)?;
    let size = fs::metadata(&created.path)?.len();
    ui::info(&format!(
        "Wrote {} ({} MiB), verified.",
        created.name,
        size.div_ceil(1 << 20)
    ));
    let provider = &answers(state)?.provider_id;
    let protected = state.rollback.as_ref().map(|point| point.backup.as_str());
    for removed in backup::prune(paths, provider, protected)? {
        ui::info(&format!("Removed the older {removed}."));
    }
    if let Some(remote) = backup::load_remote(paths)? {
        ui::info("Copying it to the bucket...");
        match remote.upload(&created.path, &created.name) {
            Ok(()) => ui::info("Copied and read back from the bucket."),
            Err(error) if matches!(reason, Reason::Manual | Reason::Scheduled) => {
                return Err(error.context(format!(
                    "{} was kept on this server but not copied off-host",
                    created.name
                )));
            }
            Err(error) => ui::info(&format!(
                "Warning: {error:#}; the backup is only on this server."
            )),
        }
    }
    Ok(created)
}

pub fn backup(dir: &Path, scheduled: bool) -> Result<()> {
    let (paths, state) = configured(dir)?;
    // A scheduled backup waits for an upgrade or restore to finish instead of failing.
    let _lock = state::lock(&paths, scheduled)?;
    let reason = if scheduled {
        Reason::Scheduled
    } else {
        Reason::Manual
    };
    let created = take(&paths, &state, &Compose::new(&paths), reason)?;
    println!("{}", created.path.display());
    Ok(())
}

pub fn list(dir: &Path) -> Result<()> {
    let (paths, state) = configured(dir)?;
    let answers = answers(&state)?;
    let names = backup::list(&paths, &answers.provider_id)?;
    if names.is_empty() {
        println!("No backups in {}.", paths.backups().display());
    }
    for name in &names {
        let size = fs::metadata(paths.backups().join(name))?.len();
        let marker = match &state.rollback {
            Some(point) if &point.backup == name => {
                format!("  (rollback point for {})", point.release)
            }
            _ => String::new(),
        };
        println!("{name}  {} MiB{marker}", size.div_ceil(1 << 20));
    }
    println!(
        "\nDaily backups: {}",
        if state.backups_scheduled {
            "on (systemctl list-timers hail-provider-backup.timer)"
        } else {
            "off"
        }
    );
    match backup::load_remote(&paths)? {
        Some(remote) => println!(
            "Off-host copies: {}/{}/{}",
            remote.endpoint, remote.bucket, remote.prefix
        ),
        None => println!("Off-host copies: not configured (hailctl backup configure)"),
    }
    Ok(())
}

pub fn configure(dir: &Path, from: Option<PathBuf>, remove: bool) -> Result<()> {
    let (paths, _) = configured(dir)?;
    let _lock = state::lock(&paths, false)?;
    if remove {
        match fs::remove_file(paths.remote()) {
            Ok(()) => ui::info("Off-host copies are off; existing copies in the bucket are kept."),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                ui::info("Off-host copies were not configured.")
            }
            Err(error) => return Err(error.into()),
        }
        return Ok(());
    }
    let remote: Remote = match from {
        Some(path) => toml::from_str(
            &fs::read_to_string(&path)
                .with_context(|| format!("cannot read {}", path.display()))?,
        )
        .with_context(|| format!("{} is invalid", path.display()))?,
        None => prompt_remote()?,
    };
    remote.check()?;
    ui::info("Checking that this server can write, read and delete in the bucket...");
    remote.test()?;
    backup::save_remote(&paths, &remote)?;
    ui::info(&format!(
        "Saved to {}. Every backup is now copied to the bucket and read back.",
        paths.remote().display()
    ));
    ui::info(
        "hailctl never deletes from the bucket: add a lifecycle rule that expires old copies.",
    );
    Ok(())
}

fn prompt_remote() -> Result<Remote> {
    ensure!(
        ui::interactive(),
        "no terminal is attached; pass --from FILE"
    );
    let text = |prompt: &str, help: &str, default: &str| -> Result<String> {
        let mut input = inquire::Text::new(prompt).with_help_message(help);
        if !default.is_empty() {
            input = input.with_default(default);
        }
        Ok(input.prompt().context("cancelled")?.trim().to_string())
    };
    Ok(Remote {
        endpoint: text(
            "S3 endpoint:",
            "R2: https://<account id>.r2.cloudflarestorage.com · B2: https://s3.<region>.backblazeb2.com · AWS: https://s3.<region>.amazonaws.com",
            "",
        )?,
        bucket: text(
            "Bucket:",
            "An existing bucket used only for these backups",
            "",
        )?,
        region: text(
            "Region:",
            "auto for R2; otherwise the bucket's region",
            "auto",
        )?,
        prefix: text(
            "Prefix:",
            "Optional folder for this provider, such as hail/",
            "",
        )?,
        access_key_id: text("Access key ID:", "A key limited to this bucket", "")?,
        secret_access_key: ui::secret("Secret access key:")?,
    })
}

/// Verifies and unpacks a backup into `paths.restore()`, decrypting with this
/// provider's KEY_ENCRYPTION_KEY.
fn extract(paths: &Paths, file: &Path) -> Result<Manifest> {
    backup::open(file, &key(paths)?, Some(&paths.restore()))
}

/// Replaces the database with an extracted backup's dump.
fn restore_extracted(paths: &Paths, compose: &Compose, manifest: &Manifest) -> Result<()> {
    let running = backup::database_version(compose)? / 10000;
    ensure!(
        manifest.database_major() <= running,
        "the backup is from PostgreSQL {}, newer than this server's {running}",
        manifest.database_major()
    );
    backup::restore_database(compose, &paths.restore().join(DUMP))?;
    fs::remove_dir_all(paths.restore())?;
    Ok(())
}

/// Moves the verified `release-next` into place, keeping the current release.
fn activate(paths: &Paths) -> Result<()> {
    let previous = paths.previous_release();
    if previous.exists() {
        fs::remove_dir_all(&previous)?;
    }
    fs::rename(paths.release(), &previous)?;
    fs::rename(paths.next_release(), paths.release())?;
    Ok(())
}

/// Puts the release kept by `activate` back.
fn revert(paths: &Paths) -> Result<()> {
    let failed = paths.dir.join("release-failed");
    if failed.exists() {
        fs::remove_dir_all(&failed)?;
    }
    fs::rename(paths.release(), &failed)?;
    fs::rename(paths.previous_release(), paths.release())?;
    fs::remove_dir_all(&failed)?;
    Ok(())
}

fn discard(path: &Path) {
    if path.exists() {
        let _ = fs::remove_dir_all(path);
    }
}

/// Returns to a backup taken just before a failed change: its data and, if the release
/// was switched, the previous release.
fn return_to(
    paths: &Paths,
    compose: &Compose,
    answers: &Answers,
    backup: &Created,
    activated: bool,
) -> Result<()> {
    let _ = compose.stop_writers();
    let manifest = extract(paths, &backup.path)?;
    restore_extracted(paths, compose, &manifest)?;
    if activated {
        revert(paths)?;
    }
    compose.run(&["up", "-d", "--wait", "--remove-orphans"])?;
    wait_ready(answers)
}

fn failed(action: &str, backup: &Created, recovered: Result<()>) -> anyhow::Error {
    match recovered {
        Ok(()) => {
            anyhow!("{action} failed; the provider was returned to its previous release and data")
        }
        Err(error) => anyhow!(
            "{action} failed, and returning to the previous state also failed ({error:#}). \
             The previous data is in {}; run `hailctl restore {}` once the cause is fixed",
            backup.path.display(),
            backup.path.display()
        ),
    }
}

pub fn upgrade(dir: &Path, tag: Option<String>) -> Result<()> {
    let (paths, mut state) = configured(dir)?;
    let _lock = state::lock(&paths, false)?;
    let answers = answers(&state)?;
    let current = installed(&state)?;
    let tag = match tag {
        Some(tag) => tag,
        None => release::latest_tag()?,
    };
    let version = |tag: &str| tag.strip_prefix("provider-v").unwrap_or(tag).to_string();
    release::check_upgrade(&version(&current), &version(&tag))?;

    ui::step(&format!("Downloading {tag}"));
    discard(&paths.next_release());
    let fetched = release::fetch(&tag, &paths.next_release())?;
    ui::info(&format!(
        "{tag} (commit {}), signature verified.",
        &fetched.release.commit[..12]
    ));

    let compose = Compose::new(&paths);
    ui::step("Backing up before the upgrade");
    ui::info("The provider is stopped until the upgrade finishes, so the backup is exact.");
    let before = match compose
        .stop_writers()
        .and_then(|()| take(&paths, &state, &compose, Reason::PreUpgrade))
    {
        Ok(created) => created,
        Err(error) => {
            let _ = compose.run(&["up", "-d", "--wait"]);
            discard(&paths.next_release());
            return Err(error.context("the backup failed, so nothing was upgraded"));
        }
    };

    ui::step(&format!("Upgrading {current} to {tag}"));
    let mut activated = false;
    let result = (|| -> Result<()> {
        activate(&paths)?;
        activated = true;
        compose.up()?;
        wait_ready(&answers)
    })();
    if let Err(error) = result {
        ui::info(&format!("The upgrade failed: {error:#}"));
        ui::info(&format!(
            "Returning to {current} and the data in {}...",
            before.name
        ));
        let recovered = return_to(&paths, &compose, &answers, &before, activated);
        return Err(failed(&format!("the upgrade to {tag}"), &before, recovered));
    }
    discard(&paths.previous_release());
    state.release = Some(tag.clone());
    state.rollback = Some(RollbackPoint {
        release: current.clone(),
        backup: before.name.clone(),
    });
    state.save(&paths)?;
    ui::info(&format!("Upgraded to {tag}."));
    ui::info(&format!(
        "If it misbehaves, `hailctl rollback` returns to {current} and the data as of {}.",
        when(before.manifest.created_at)
    ));

    // hailctl only moves forward: a newer hailctl may install an older provider release.
    if release::parse_version(&fetched.release.release)
        > release::parse_version(env!("CARGO_PKG_VERSION"))
    {
        match release::install_hailctl(&fetched.release) {
            Ok(path) => ui::info(&format!(
                "Updated hailctl at {} to {}.",
                path.display(),
                fetched.release.release
            )),
            Err(error) => ui::info(&format!(
                "Warning: hailctl was not updated ({error:#}); run `curl -fsSL https://get.racrproto.com/{tag} | sh`."
            )),
        }
    }
    let env = Env::load(&paths.env())?;
    if crate::bridge::enabled(&env)
        && let Err(error) = crate::bridge::database_roles(&compose, &env)
    {
        ui::info(&format!(
            "Warning: the email bridge's database role was not updated ({error:#})."
        ));
    }
    if let Err(error) = ensure_schedule(&paths, &mut state) {
        ui::info(&format!(
            "Warning: daily backups are not scheduled ({error:#})."
        ));
    }
    Ok(())
}

pub fn ensure_schedule(paths: &Paths, state: &mut State) -> Result<()> {
    if !state.backups_scheduled {
        backup::schedule(paths)?;
        state.backups_scheduled = true;
        state.save(paths)?;
    }
    Ok(())
}

pub fn rollback(dir: &Path, yes: bool) -> Result<()> {
    let (paths, mut state) = configured(dir)?;
    let _lock = state::lock(&paths, false)?;
    let point = state.rollback.clone().ok_or_else(|| {
        anyhow!(
            "there is no upgrade to roll back; restore a specific backup with `hailctl restore FILE` (see `hailctl backup list`)"
        )
    })?;
    let file = paths.backups().join(&point.backup);
    ensure!(
        file.is_file(),
        "the pre-upgrade backup {} is missing",
        file.display()
    );
    replace(
        &paths,
        &mut state,
        &file,
        Reason::PreRollback,
        yes,
        &format!("Roll back to {}", point.release),
    )
}

pub fn restore(dir: &Path, file: &Path, yes: bool) -> Result<()> {
    let (paths, mut state) = configured(dir)?;
    let _lock = state::lock(&paths, false)?;
    replace(&paths, &mut state, file, Reason::PreRestore, yes, "Restore")
}

/// Replaces the running data (and release, if different) with a backup's.
fn replace(
    paths: &Paths,
    state: &mut State,
    file: &Path,
    safety: Reason,
    yes: bool,
    action: &str,
) -> Result<()> {
    let answers = answers(state)?;
    let current = installed(state)?;
    ui::step("Checking the backup");
    let manifest = extract(paths, file)?;
    if manifest.provider_id != answers.provider_id || manifest.api_host != answers.api_host {
        discard(&paths.restore());
        bail!(
            "this backup is from provider {} ({}), not {} ({})",
            manifest.provider_id,
            manifest.api_host,
            answers.provider_id,
            answers.api_host
        );
    }
    ui::info(&format!(
        "A {} backup from {}, release {}.",
        manifest.reason,
        when(manifest.created_at),
        manifest.release
    ));
    ui::info("Everything written after that time is lost: messages, new accounts and settings.");
    ui::info("Identity changes published since then (new accounts, key rotations) remain in the");
    ui::info("PLC directory and may need recovery for the affected accounts.");
    let confirmed = yes || ui::interactive() && ui::confirm(&format!("{action}?"), false)?;
    if !confirmed {
        discard(&paths.restore());
        bail!("not confirmed; pass --yes to proceed without a prompt");
    }

    let changes_release = manifest.release != current;
    if changes_release {
        ui::step(&format!("Downloading {}", manifest.release));
        discard(&paths.next_release());
        if let Err(error) = release::fetch(&manifest.release, &paths.next_release()) {
            discard(&paths.restore());
            return Err(error);
        }
    }

    let compose = Compose::new(paths);
    ui::step("Backing up the current data first");
    // The target backup stays extracted; the safety backup uses its own work directory.
    let before = match compose
        .stop_writers()
        .and_then(|()| take(paths, state, &compose, safety))
    {
        Ok(created) => created,
        Err(error) => {
            let _ = compose.run(&["up", "-d", "--wait"]);
            discard(&paths.next_release());
            discard(&paths.restore());
            return Err(error.context("the backup failed, so nothing was changed"));
        }
    };

    ui::step(action);
    let mut activated = false;
    let result = (|| -> Result<()> {
        restore_extracted(paths, &compose, &manifest)?;
        if changes_release {
            activate(paths)?;
            activated = true;
        }
        compose.up()?;
        wait_ready(&answers)
    })();
    if let Err(error) = result {
        ui::info(&format!("{action} failed: {error:#}"));
        ui::info(&format!(
            "Returning to {current} and the data in {}...",
            before.name
        ));
        let recovered = return_to(paths, &compose, &answers, &before, activated);
        return Err(failed(action, &before, recovered));
    }
    discard(&paths.previous_release());
    state.release = Some(manifest.release.clone());
    // The data no longer matches the last upgrade's rollback point.
    state.rollback = None;
    state.save(paths)?;
    ui::info(&format!(
        "Done: running {} with the data as of {}.",
        manifest.release,
        when(manifest.created_at)
    ));
    ui::info(&format!(
        "The data from just before this is in {}.",
        before.path.display()
    ));
    Ok(())
}

/// `install --restore`: seeds a fresh install directory from a backup. The database is
/// restored once the backup's release is downloaded and PostgreSQL is running.
pub fn seed(paths: &Paths, file: &Path) -> Result<State> {
    let key = backup::prompt_key()?;
    ui::step("Reading the backup");
    let manifest = backup::open(file, &key, Some(&paths.restore()))?;
    let mut env = Env::load(&paths.restore().join("provider.env"))?;
    env.set(KEY, &key);
    let saved: State = serde_json::from_slice(&fs::read(paths.restore().join("hailctl.json"))?)
        .context("the backup's hailctl.json is corrupt")?;
    let answers = saved
        .answers
        .clone()
        .ok_or_else(|| anyhow!("the backup has no provider settings"))?;
    ensure!(
        answers.provider_id == manifest.provider_id && answers.api_host == manifest.api_host,
        "the backup's settings do not match its manifest"
    );
    env.save(&paths.env())?;
    fs::remove_file(paths.restore().join("provider.env"))?;
    fs::remove_file(paths.restore().join("hailctl.json"))?;
    ui::info(&format!(
        "Provider {} ({}), {} backup from {}, release {}.",
        answers.provider_id,
        answers.api_host,
        manifest.reason,
        when(manifest.created_at),
        manifest.release
    ));
    let state = State {
        answers: Some(answers),
        configured: true,
        registered: saved.registered,
        accounts: saved.accounts,
        restoring: Some(manifest.release),
        ..State::default()
    };
    state.save(paths)?;
    Ok(state)
}

/// Restores the seeded database into a fresh PostgreSQL before the provider first starts.
pub fn finish_seed(paths: &Paths, state: &mut State, compose: &Compose) -> Result<()> {
    ui::step("Restoring the database");
    compose.run(&["up", "-d", "--wait", "db"])?;
    backup::restore_database(compose, &paths.restore().join(DUMP))?;
    // A new database server has none of the bridge converter's roles.
    let env = Env::load(&paths.env())?;
    if crate::bridge::enabled(&env) {
        crate::bridge::database_roles(compose, &env)?;
    }
    fs::remove_dir_all(paths.restore())?;
    state.restoring = None;
    state.save(paths)?;
    ui::info("Restored.");
    Ok(())
}
