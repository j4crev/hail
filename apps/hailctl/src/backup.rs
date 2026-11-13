//! Provider backups: an age-encrypted tar of the PostgreSQL dump, `.env` (without
//! KEY_ENCRYPTION_KEY) and hailctl.json. The passphrase is KEY_ENCRYPTION_KEY, which the
//! operator stored offline at install, so restoring needs only the file and that key.
//! `age -d` decrypts a backup without hailctl.
use crate::compose::Compose;
use crate::s3::Remote;
use crate::state::{Env, Paths, State, write_private};
use age::secrecy::SecretString;
use anyhow::{Context, Result, anyhow, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

pub const KEY: &str = "KEY_ENCRYPTION_KEY";
const DUMP: &str = "hail.dump";
const ENV: &str = "provider.env";
const STATE: &str = "hailctl.json";
const MANIFEST: &str = "manifest.json";
const SUFFIX: &str = ".tar.age";
const UNIT: &str = "hail-provider-backup";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Reason {
    Manual,
    Scheduled,
    PreUpgrade,
    PreRollback,
    PreRestore,
}

impl Reason {
    pub const ALL: [Reason; 5] = [
        Reason::Manual,
        Reason::Scheduled,
        Reason::PreUpgrade,
        Reason::PreRollback,
        Reason::PreRestore,
    ];
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::Manual => "manual",
            Reason::Scheduled => "scheduled",
            Reason::PreUpgrade => "pre-upgrade",
            Reason::PreRollback => "pre-rollback",
            Reason::PreRestore => "pre-restore",
        }
    }
    fn parse(value: &str) -> Option<Reason> {
        Reason::ALL.into_iter().find(|r| r.as_str() == value)
    }
    /// Local copies kept for this kind of backup.
    pub fn keep(self) -> usize {
        match self {
            Reason::Scheduled => 7,
            _ => 3,
        }
    }
}

/// `hail.provider-backup` version 1, the first entry of every backup.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Manifest {
    #[serde(rename = "type")]
    pub kind: String,
    pub version: u32,
    /// Unix seconds.
    pub created_at: u64,
    pub reason: String,
    pub provider_id: String,
    pub api_host: String,
    pub web_host: String,
    /// The provider release whose schema the dump has.
    pub release: String,
    /// PostgreSQL `server_version_num`.
    pub database_version: u32,
    /// SHA-256 (hex) of each other entry.
    pub files: BTreeMap<String, String>,
}

impl Manifest {
    fn check(&self) -> Result<()> {
        let names: Vec<&str> = self.files.keys().map(String::as_str).collect();
        ensure!(
            self.kind == "hail.provider-backup"
                && self.version == 1
                && Reason::parse(&self.reason).is_some()
                && crate::release::version_of_tag(&self.release).is_some()
                && names == [DUMP, STATE, ENV]
                && self.files.values().all(|hash| {
                    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())
                }),
            "the backup manifest is malformed"
        );
        Ok(())
    }
    pub fn database_major(&self) -> u32 {
        self.database_version / 10000
    }
}

/// (year, month, day, hour, minute, second) in UTC.
pub fn utc(seconds: u64) -> (i64, u32, u32, u32, u32, u32) {
    let days = (seconds / 86400) as i64;
    let rest = seconds % 86400;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (
        year,
        month,
        day,
        (rest / 3600) as u32,
        (rest % 3600 / 60) as u32,
        (rest % 60) as u32,
    )
}

pub fn stamp(seconds: u64) -> String {
    let (y, mo, d, h, mi, s) = utc(seconds);
    format!("{y:04}{mo:02}{d:02}T{h:02}{mi:02}{s:02}Z")
}

pub fn file_name(provider_id: &str, created_at: u64, reason: Reason) -> String {
    format!(
        "{provider_id}-{}-{}{SUFFIX}",
        stamp(created_at),
        reason.as_str()
    )
}

/// The timestamp and reason of a backup file name for this provider.
pub fn parse_name<'a>(name: &'a str, provider_id: &str) -> Option<(&'a str, Reason)> {
    let rest = name
        .strip_prefix(provider_id)?
        .strip_prefix('-')?
        .strip_suffix(SUFFIX)?;
    let (stamp, reason) = rest.split_at_checked(16)?;
    let valid_stamp = stamp.len() == 16
        && stamp.bytes().enumerate().all(|(i, b)| match i {
            8 => b == b'T',
            15 => b == b'Z',
            _ => b.is_ascii_digit(),
        });
    if !valid_stamp {
        return None;
    }
    Some((stamp, Reason::parse(reason.strip_prefix('-')?)?))
}

fn private_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn hash_file(path: &Path) -> Result<String> {
    let mut hasher = Sha256::new();
    std::io::copy(&mut File::open(path)?, &mut hasher)?;
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// The running database's `server_version_num`.
pub fn database_version(compose: &Compose) -> Result<u32> {
    compose
        .output(&[
            "exec",
            "-T",
            "db",
            "psql",
            "-X",
            "-U",
            "hail",
            "-d",
            "hail",
            "-Atq",
            "-c",
            "SHOW server_version_num",
        ])?
        .trim()
        .parse()
        .context("unexpected PostgreSQL version output")
}

fn database_bytes(compose: &Compose) -> Result<u64> {
    compose
        .output(&[
            "exec",
            "-T",
            "db",
            "psql",
            "-X",
            "-U",
            "hail",
            "-d",
            "hail",
            "-Atq",
            "-c",
            "SELECT pg_database_size('hail')",
        ])?
        .trim()
        .parse()
        .context("unexpected database size output")
}

pub struct Created {
    pub name: String,
    pub path: PathBuf,
    pub manifest: Manifest,
}

/// Dumps the database and writes an encrypted, verified backup into `paths.backups()`.
pub fn create(paths: &Paths, state: &State, compose: &Compose, reason: Reason) -> Result<Created> {
    let answers = state
        .answers
        .as_ref()
        .ok_or_else(|| anyhow!("hailctl.json has no answers"))?;
    let release = state
        .release
        .clone()
        .ok_or_else(|| anyhow!("no release is installed"))?;
    let env = Env::load(&paths.env())?;
    let key = env
        .get(KEY)
        .filter(|k| !k.is_empty())
        .ok_or_else(|| anyhow!("{} has no {KEY}", paths.env().display()))?
        .to_string();
    let directory = paths.backups();
    private_dir(&directory)?;
    let needed = database_bytes(compose)? + (1 << 30);
    let available = crate::host::available_bytes(&directory)?;
    ensure!(
        available >= needed,
        "{} MiB free in {}; a backup needs about {} MiB",
        available >> 20,
        directory.display(),
        needed >> 20
    );

    let created_at = crate::register::now();
    let name = file_name(&answers.provider_id, created_at, reason);
    let work = directory.join(format!(".work-{}", stamp(created_at)));
    if work.exists() {
        fs::remove_dir_all(&work)?;
    }
    private_dir(&work)?;
    let result = (|| {
        let dump = work.join(DUMP);
        compose.to_file(
            &[
                "exec", "-T", "db", "pg_dump", "-U", "hail", "-d", "hail", "-Fc",
            ],
            &dump,
        )?;
        // pg_restore --list reads the whole archive's table of contents.
        compose.feed_file(&["exec", "-T", "db", "pg_restore", "--list"], &dump)?;
        let mut stripped = env.clone();
        stripped.remove(KEY);
        write_private(&work.join(ENV), stripped.render().as_bytes())?;
        write_private(&work.join(STATE), &serde_json::to_vec_pretty(state)?)?;
        let mut files = BTreeMap::new();
        for file in [DUMP, ENV, STATE] {
            files.insert(file.to_string(), hash_file(&work.join(file))?);
        }
        let manifest = Manifest {
            kind: "hail.provider-backup".into(),
            version: 1,
            created_at,
            reason: reason.as_str().into(),
            provider_id: answers.provider_id.clone(),
            api_host: answers.api_host.clone(),
            web_host: answers.web_host.clone(),
            release,
            database_version: database_version(compose)?,
            files,
        };
        let partial = directory.join(format!(".{name}.partial"));
        write_archive(&partial, &key, &manifest, &work)?;
        // Prove the file decrypts and every entry matches before calling it a backup.
        let read = open(&partial, &key, None)?;
        ensure!(read == manifest, "the written backup does not read back");
        let path = directory.join(&name);
        fs::rename(&partial, &path)?;
        Ok(Created {
            name: name.clone(),
            path,
            manifest,
        })
    })();
    let _ = fs::remove_dir_all(&work);
    let _ = fs::remove_file(directory.join(format!(".{name}.partial")));
    result
}

fn write_archive(path: &Path, key: &str, manifest: &Manifest, work: &Path) -> Result<()> {
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    let encryptor = age::Encryptor::with_user_passphrase(SecretString::from(key.to_string()));
    let mut builder = tar::Builder::new(encryptor.wrap_output(BufWriter::new(file))?);
    let entry = |size: u64| {
        let mut header = tar::Header::new_gnu();
        header.set_size(size);
        header.set_mode(0o600);
        header.set_mtime(manifest.created_at);
        header.set_entry_type(tar::EntryType::Regular);
        header
    };
    let bytes = serde_json::to_vec_pretty(manifest)?;
    builder.append_data(&mut entry(bytes.len() as u64), MANIFEST, bytes.as_slice())?;
    for name in [DUMP, ENV, STATE] {
        let mut file = File::open(work.join(name))?;
        let size = file.metadata()?.len();
        builder.append_data(&mut entry(size), name, &mut file)?;
    }
    let writer = builder.into_inner()?.finish()?;
    let file = writer.into_inner().map_err(|e| e.into_error())?;
    file.sync_all()?;
    Ok(())
}

/// Decrypts a backup and checks every entry against its manifest, extracting the entries
/// into `extract` (created 0700) when given.
pub fn open(path: &Path, key: &str, extract: Option<&Path>) -> Result<Manifest> {
    let file = File::open(path).with_context(|| format!("cannot read {}", path.display()))?;
    let decryptor = age::Decryptor::new(BufReader::new(file))
        .map_err(|e| anyhow!("{} is not an age-encrypted backup: {e}", path.display()))?;
    ensure!(
        decryptor.is_scrypt(),
        "{} is not a passphrase-encrypted hail backup",
        path.display()
    );
    let identity = age::scrypt::Identity::new(SecretString::from(key.to_string()));
    let reader = decryptor
        .decrypt(std::iter::once(&identity as &dyn age::Identity))
        .map_err(|_| {
            anyhow!(
                "{} could not be decrypted: it was made with a different {KEY}",
                path.display()
            )
        })?;
    if let Some(directory) = extract {
        if directory.exists() {
            fs::remove_dir_all(directory)?;
        }
        private_dir(directory)?;
    }
    let mut archive = tar::Archive::new(reader);
    let mut manifest: Option<Manifest> = None;
    let mut seen = Vec::new();
    for entry in archive.entries()? {
        let mut entry = entry?;
        ensure!(
            entry.header().entry_type() == tar::EntryType::Regular,
            "unexpected entry type in the backup"
        );
        let name = entry.path()?.to_string_lossy().into_owned();
        let Some(expected) = &manifest else {
            ensure!(
                name == MANIFEST,
                "the backup does not start with its manifest"
            );
            let mut bytes = Vec::new();
            entry.by_ref().take(1 << 20).read_to_end(&mut bytes)?;
            let parsed: Manifest =
                serde_json::from_slice(&bytes).context("the backup manifest is not valid JSON")?;
            parsed.check()?;
            manifest = Some(parsed);
            continue;
        };
        let hash = expected
            .files
            .get(&name)
            .ok_or_else(|| anyhow!("unexpected file {name} in the backup"))?;
        ensure!(!seen.contains(&name), "duplicate file {name} in the backup");
        let mut hasher = Sha256::new();
        match extract {
            Some(directory) => {
                let mut out = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(directory.join(&name))?;
                let mut buffer = vec![0; 1 << 16];
                loop {
                    let read = entry.read(&mut buffer)?;
                    if read == 0 {
                        break;
                    }
                    hasher.update(&buffer[..read]);
                    out.write_all(&buffer[..read])?;
                }
                out.sync_all()?;
            }
            None => {
                std::io::copy(&mut entry, &mut hasher)?;
            }
        }
        let actual: String = hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        ensure!(&actual == hash, "{name} in the backup is corrupt");
        seen.push(name);
    }
    let manifest = manifest.ok_or_else(|| anyhow!("the backup is empty"))?;
    ensure!(
        seen.len() == manifest.files.len(),
        "the backup is missing files"
    );
    Ok(manifest)
}

/// Replaces the `hail` database with a dump. The dump is restored into a new database
/// first, so a failed restore leaves the current data untouched. The provider and web
/// client must be stopped.
pub fn restore_database(compose: &Compose, dump: &Path) -> Result<()> {
    let psql = |sql: &str| -> Result<()> {
        compose.output(&[
            "exec",
            "-T",
            "-e",
            "PGOPTIONS=-c client_min_messages=warning",
            "db",
            "psql",
            "-X",
            "-q",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            "hail",
            "-d",
            "postgres",
            "-c",
            sql,
        ])?;
        Ok(())
    };
    psql("DROP DATABASE IF EXISTS hail_restore WITH (FORCE)")?;
    psql("CREATE DATABASE hail_restore OWNER hail")?;
    if let Err(error) = compose.feed_file(
        &[
            "exec",
            "-T",
            "db",
            "pg_restore",
            "-U",
            "hail",
            "-d",
            "hail_restore",
            "--exit-on-error",
            "--single-transaction",
            "--no-owner",
        ],
        dump,
    ) {
        let _ = psql("DROP DATABASE IF EXISTS hail_restore WITH (FORCE)");
        return Err(error.context("the dump did not restore; the current database is unchanged"));
    }
    psql("DROP DATABASE hail WITH (FORCE)")?;
    psql("ALTER DATABASE hail_restore RENAME TO hail")?;
    Ok(())
}

/// Deletes old local backups beyond each reason's limit, never `protected`.
pub fn prune(paths: &Paths, provider_id: &str, protected: Option<&str>) -> Result<Vec<String>> {
    let mut by_reason: BTreeMap<Reason, Vec<String>> = BTreeMap::new();
    for name in list(paths, provider_id)? {
        if let Some((_, reason)) = parse_name(&name, provider_id) {
            by_reason.entry(reason).or_default().push(name);
        }
    }
    let mut removed = Vec::new();
    for (reason, mut names) in by_reason {
        names.sort_unstable_by(|a, b| b.cmp(a));
        for name in names.into_iter().skip(reason.keep()) {
            if Some(name.as_str()) != protected {
                fs::remove_file(paths.backups().join(&name))?;
                removed.push(name);
            }
        }
    }
    Ok(removed)
}

/// This provider's local backups, oldest first.
pub fn list(paths: &Paths, provider_id: &str) -> Result<Vec<String>> {
    let mut names = Vec::new();
    match fs::read_dir(paths.backups()) {
        Ok(entries) => {
            for entry in entries {
                let name = entry?.file_name().to_string_lossy().into_owned();
                if parse_name(&name, provider_id).is_some() {
                    names.push(name);
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    names.sort_unstable_by(|a, b| {
        let stamp = |n: &str| parse_name(n, provider_id).map(|(s, _)| s.to_string());
        stamp(a).cmp(&stamp(b)).then(a.cmp(b))
    });
    Ok(names)
}

pub fn load_remote(paths: &Paths) -> Result<Option<Remote>> {
    match fs::read_to_string(paths.remote()) {
        Ok(text) => {
            let remote: Remote = toml::from_str(&text)
                .with_context(|| format!("{} is invalid", paths.remote().display()))?;
            remote.check()?;
            Ok(Some(remote))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn save_remote(paths: &Paths, remote: &Remote) -> Result<()> {
    write_private(&paths.remote(), toml::to_string(remote)?.as_bytes())
}

/// Installs and starts the daily backup timer, as a systemd user unit of the `hail` user
/// (its manager runs at boot through lingering).
pub fn schedule(paths: &Paths) -> Result<()> {
    let executable = std::env::current_exe().context("cannot locate the hailctl executable")?;
    let directory = paths.dir.to_string_lossy();
    let units = PathBuf::from(std::env::var("HOME").context("HOME is not set")?)
        .join(".config/systemd/user");
    fs::create_dir_all(&units)?;
    for (path, text) in [
        (
            units.join(format!("{UNIT}.service")),
            format!(
                "[Unit]\nDescription=Hail provider backup\nRequires=docker.service\nAfter=docker.service\n\n[Service]\nType=oneshot\nExecStart={} --dir {directory} backup --scheduled\nNice=10\nIOSchedulingClass=idle\n",
                executable.display()
            ),
        ),
        (
            units.join(format!("{UNIT}.timer")),
            "[Unit]\nDescription=Daily Hail provider backup\n\n[Timer]\nOnCalendar=daily\nRandomizedDelaySec=1h\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n".to_string(),
        ),
    ] {
        fs::write(&path, text).with_context(|| format!("cannot write {}", path.display()))?;
    }
    crate::host::run("systemctl", &["--user", "daemon-reload"])?;
    crate::host::run(
        "systemctl",
        &["--user", "enable", "--now", &format!("{UNIT}.timer")],
    )?;
    Ok(())
}

/// The KEY_ENCRYPTION_KEY that decrypts backups, for a server that does not have it yet.
pub fn prompt_key() -> Result<String> {
    let key = match std::env::var("HAILCTL_KEY_ENCRYPTION_KEY") {
        Ok(key) => key,
        Err(_) => {
            ensure!(
                crate::ui::interactive(),
                "set HAILCTL_KEY_ENCRYPTION_KEY to the provider's {KEY}"
            );
            crate::ui::secret(&format!("The provider's {KEY}:"))?
        }
    };
    let key = key.trim().to_string();
    if key.is_empty() {
        bail!("{KEY} is required to restore a backup");
    }
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_utc_timestamps() {
        assert_eq!(stamp(0), "19700101T000000Z");
        assert_eq!(stamp(951_782_400), "20000229T000000Z");
        assert_eq!(stamp(1_794_528_000 + 3661), "20261113T010101Z");
    }

    #[test]
    fn names_round_trip() {
        let name = file_name("example", 1_794_528_000, Reason::PreUpgrade);
        assert_eq!(name, "example-20261113T000000Z-pre-upgrade.tar.age");
        assert_eq!(
            parse_name(&name, "example"),
            Some(("20261113T000000Z", Reason::PreUpgrade))
        );
        assert_eq!(parse_name(&name, "other"), None);
        assert_eq!(
            parse_name("example-2026112T000000Z-manual.tar.age", "example"),
            None
        );
        assert_eq!(
            parse_name("example-20261121T000000Z-weekly.tar.age", "example"),
            None
        );
    }

    fn manifest(dump: &[u8], env: &[u8], state: &[u8]) -> Manifest {
        let hash = |b: &[u8]| -> String {
            Sha256::digest(b)
                .iter()
                .map(|x| format!("{x:02x}"))
                .collect()
        };
        Manifest {
            kind: "hail.provider-backup".into(),
            version: 1,
            created_at: 1_794_528_000,
            reason: "manual".into(),
            provider_id: "example".into(),
            api_host: "svr.example.org".into(),
            web_host: "example.org".into(),
            release: "provider-v0.3.0".into(),
            database_version: 180_006,
            files: BTreeMap::from([
                (DUMP.into(), hash(dump)),
                (ENV.into(), hash(env)),
                (STATE.into(), hash(state)),
            ]),
        }
    }

    #[test]
    fn encrypts_verifies_and_extracts() {
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        fs::create_dir(&work).unwrap();
        let (dump, env, state) = (
            b"PGDMP fake".as_slice(),
            b"DB_PASSWORD=x\n".as_slice(),
            b"{}".as_slice(),
        );
        fs::write(work.join(DUMP), dump).unwrap();
        fs::write(work.join(ENV), env).unwrap();
        fs::write(work.join(STATE), state).unwrap();
        let manifest = manifest(dump, env, state);
        let archive = dir.path().join("b.tar.age");
        write_archive(&archive, "the-key", &manifest, &work).unwrap();

        assert_eq!(open(&archive, "the-key", None).unwrap(), manifest);
        let out = dir.path().join("out");
        open(&archive, "the-key", Some(&out)).unwrap();
        assert_eq!(fs::read(out.join(DUMP)).unwrap(), dump);
        assert_eq!(
            fs::metadata(out.join(ENV)).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let wrong = open(&archive, "another-key", None).unwrap_err();
        assert!(
            wrong.to_string().contains("different KEY_ENCRYPTION_KEY"),
            "{wrong}"
        );

        // A manifest that does not match the contents is rejected.
        let mut lying = manifest.clone();
        lying.files.insert(DUMP.into(), "0".repeat(64));
        let bad = dir.path().join("bad.tar.age");
        write_archive(&bad, "the-key", &lying, &work).unwrap();
        assert!(
            open(&bad, "the-key", None)
                .unwrap_err()
                .to_string()
                .contains("corrupt")
        );
    }

    #[test]
    fn prunes_by_reason_and_keeps_the_rollback_point() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path());
        fs::create_dir(paths.backups()).unwrap();
        let day = 86_400;
        let mut names = Vec::new();
        for i in 0..10 {
            names.push(file_name(
                "example",
                1_794_528_000 + i * day,
                Reason::Scheduled,
            ));
        }
        for i in 0..5 {
            names.push(file_name(
                "example",
                1_794_528_000 + i * day + 1,
                Reason::PreUpgrade,
            ));
        }
        for name in &names {
            fs::write(paths.backups().join(name), b"").unwrap();
        }
        fs::write(
            paths
                .backups()
                .join("other-20261121T000000Z-manual.tar.age"),
            b"",
        )
        .unwrap();
        let protected = names[10].clone(); // the oldest pre-upgrade backup
        let removed = prune(&paths, "example", Some(&protected)).unwrap();
        assert_eq!(removed.len(), 3 + 1);
        let left = list(&paths, "example").unwrap();
        assert_eq!(left.iter().filter(|n| n.contains("scheduled")).count(), 7);
        assert!(left.contains(&protected));
        assert!(!left.contains(&names[0]));
        assert!(
            paths
                .backups()
                .join("other-20261121T000000Z-manual.tar.age")
                .exists()
        );
    }
}
