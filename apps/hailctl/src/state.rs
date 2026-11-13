//! Install answers, resumable state and the provider `.env`, all under the install
//! directory and readable only by root.
use anyhow::{Context, Result, bail, ensure};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

pub const DEFAULT_DIR: &str = "/opt/hail-provider";
pub const DEFAULT_MONITOR_API: &str = "https://enroll.plcmonitor.us";

/// Install answers, from prompts or an answers file (TOML).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Answers {
    /// API and federation hostname, e.g. `svr.example.com`.
    pub api_host: String,
    /// Web client hostname and address domain, e.g. `example.com` (addresses are `name@example.com`).
    pub web_host: String,
    /// Short lowercase identifier for this provider, e.g. `example`.
    pub provider_id: String,
    /// Operator contact; receives the registration code and operator notices.
    pub operator_email: String,
    /// Shared monitor registration API.
    #[serde(default = "default_monitor_api")]
    pub monitor_api: String,
    /// Unattended installs: write secrets that must be backed up to a root-only file
    /// instead of showing them and asking for confirmation.
    #[serde(default)]
    pub secrets_to_file: bool,
}

fn default_monitor_api() -> String {
    DEFAULT_MONITOR_API.to_string()
}

pub fn valid_hostname(host: &str) -> bool {
    host.len() <= 253
        && host.contains('.')
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                && !label.starts_with('-')
                && !label.ends_with('-')
        })
        && !host
            .split('.')
            .next_back()
            .is_some_and(|tld| tld.bytes().all(|b| b.is_ascii_digit()))
}

pub fn valid_provider_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 63
        && id.as_bytes()[0].is_ascii_lowercase()
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub fn valid_email(email: &str) -> bool {
    email.len() <= 254
        && email.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty()
                && !local.contains(char::is_whitespace)
                && valid_hostname(&domain.to_ascii_lowercase())
        })
}

impl Answers {
    pub fn check(&self) -> Result<()> {
        ensure!(
            valid_hostname(&self.api_host),
            "api_host must be a lowercase DNS name such as svr.example.com"
        );
        ensure!(
            valid_hostname(&self.web_host),
            "web_host must be a lowercase DNS name such as example.com"
        );
        ensure!(
            self.api_host != self.web_host,
            "api_host and web_host must differ"
        );
        ensure!(
            valid_provider_id(&self.provider_id),
            "provider_id must be lowercase letters, digits and hyphens, starting with a letter"
        );
        ensure!(
            valid_email(&self.operator_email),
            "operator_email is not a valid email address"
        );
        ensure!(
            self.monitor_api.starts_with("https://") && valid_hostname(&self.monitor_api[8..]),
            "monitor_api must be an https:// origin"
        );
        Ok(())
    }
    pub fn api_origin(&self) -> String {
        format!("https://{}", self.api_host)
    }
    pub fn web_origin(&self) -> String {
        format!("https://{}", self.web_host)
    }
}

pub fn load_answers(path: &Path) -> Result<Answers> {
    let answers: Answers = toml::from_str(
        &fs::read_to_string(path).with_context(|| format!("cannot read {}", path.display()))?,
    )
    .with_context(|| format!("{} is not a valid answers file", path.display()))?;
    answers.check()?;
    Ok(answers)
}

/// A pending monitor registration; its secret is private.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Registration {
    pub secret: String,
    pub expires_at: u64,
}

/// Completed install steps, so a re-run resumes where it stopped.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct State {
    pub answers: Option<Answers>,
    /// Installed release tag.
    pub release: Option<String>,
    pub configured: bool,
    pub started: bool,
    pub registration: Option<Registration>,
    pub registered: bool,
    pub accounts: bool,
    /// The daily backup timer is installed.
    pub backups_scheduled: bool,
    /// Set by a successful upgrade: what `hailctl rollback` returns to.
    pub rollback: Option<RollbackPoint>,
    /// `install --restore`: the backup's release, until its database is restored.
    pub restoring: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RollbackPoint {
    /// The release before the upgrade.
    pub release: String,
    /// The pre-upgrade backup's file name in the backups directory.
    pub backup: String,
}

pub struct Paths {
    pub dir: PathBuf,
}

impl Paths {
    pub fn new(dir: &Path) -> Self {
        Paths {
            dir: dir.to_path_buf(),
        }
    }
    pub fn state(&self) -> PathBuf {
        self.dir.join("hailctl.json")
    }
    pub fn env(&self) -> PathBuf {
        self.dir.join(".env")
    }
    pub fn release(&self) -> PathBuf {
        self.dir.join("release")
    }
    pub fn registration(&self) -> PathBuf {
        self.release().join("registration")
    }
    pub fn secrets(&self) -> PathBuf {
        self.dir.join("BACK-UP-THESE-SECRETS.txt")
    }
    pub fn backups(&self) -> PathBuf {
        self.dir.join("backups")
    }
    /// Off-host backup bucket settings (holds credentials).
    pub fn remote(&self) -> PathBuf {
        self.dir.join("backup-remote.toml")
    }
    /// Backup contents being restored.
    pub fn restore(&self) -> PathBuf {
        self.dir.join("restore")
    }
    /// The next release, verified and unpacked before it replaces `release()`.
    pub fn next_release(&self) -> PathBuf {
        self.dir.join("release-next")
    }
    pub fn previous_release(&self) -> PathBuf {
        self.dir.join("release-previous")
    }
}

/// Holds an exclusive lock on the install directory, so two hailctl commands never
/// change one provider at once.
pub fn lock(paths: &Paths, wait: bool) -> Result<fs::File> {
    fs::create_dir_all(&paths.dir)?;
    fs::set_permissions(&paths.dir, fs::Permissions::from_mode(0o700))?;
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .mode(0o600)
        .open(paths.dir.join(".hailctl.lock"))?;
    if wait {
        file.lock()?;
    } else if file.try_lock().is_err() {
        bail!("another hailctl command is running on this provider");
    }
    Ok(file)
}

/// Writes a file readable only by its owner, replacing it atomically.
pub fn write_private(path: &Path, contents: &[u8]) -> Result<()> {
    let temporary = path.with_extension("tmp");
    {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(contents)?;
        file.sync_all()?;
    }
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))?;
    fs::rename(&temporary, path)?;
    Ok(())
}

impl State {
    pub fn load(paths: &Paths) -> Result<State> {
        match fs::read(paths.state()) {
            Ok(bytes) => serde_json::from_slice(&bytes).context("hailctl.json is corrupt"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(State::default()),
            Err(error) => Err(error.into()),
        }
    }
    pub fn save(&self, paths: &Paths) -> Result<()> {
        fs::create_dir_all(&paths.dir)?;
        fs::set_permissions(&paths.dir, fs::Permissions::from_mode(0o700))?;
        write_private(&paths.state(), &serde_json::to_vec_pretty(self)?)
    }
}

/// A 32-byte random secret, unpadded base64url.
pub fn secret() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// The provider `.env`: ordered `KEY=value` lines, edited in place so existing values
/// (secrets in particular) are never regenerated.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Env {
    lines: Vec<(String, String)>,
}

impl Env {
    pub fn parse(text: &str) -> Result<Env> {
        let mut lines = Vec::new();
        for line in text
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
        {
            let Some((key, value)) = line.split_once('=') else {
                bail!("malformed .env line")
            };
            lines.push((key.to_string(), value.to_string()));
        }
        Ok(Env { lines })
    }
    pub fn load(path: &Path) -> Result<Env> {
        match fs::read_to_string(path) {
            Ok(text) => Env::parse(&text),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Env::default()),
            Err(error) => Err(error.into()),
        }
    }
    pub fn get(&self, key: &str) -> Option<&str> {
        self.lines
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }
    pub fn remove(&mut self, key: &str) {
        self.lines.retain(|(k, _)| k != key);
    }
    pub fn set(&mut self, key: &str, value: &str) {
        match self.lines.iter_mut().find(|(k, _)| k == key) {
            Some(line) => line.1 = value.to_string(),
            None => self.lines.push((key.to_string(), value.to_string())),
        }
    }
    /// Sets a value only when it is missing, returning the effective value.
    pub fn ensure(&mut self, key: &str, value: impl FnOnce() -> String) -> String {
        if let Some(existing) = self.get(key) {
            return existing.to_string();
        }
        let value = value();
        self.set(key, &value);
        value
    }
    pub fn render(&self) -> String {
        let mut text = String::from(
            "# Managed by hailctl. Back up this file: it holds the provider's secrets.\n",
        );
        for (key, value) in &self.lines {
            text.push_str(&format!("{key}={value}\n"));
        }
        text
    }
    pub fn save(&self, path: &Path) -> Result<()> {
        write_private(path, self.render().as_bytes())
    }
}

/// Repairs a `.env` written by hailctl 0.2.0, which added the signup invitation key
/// before registration; the provider refuses to start with it while signup is off.
/// Returns whether anything changed.
pub fn repair_env(env: &mut Env) -> bool {
    if env.get("PUBLIC_ALPHA_SIGNUP") != Some("true")
        && env.get("ALPHA_SIGNUP_INVITE_KEY").is_some()
    {
        env.remove("ALPHA_SIGNUP_INVITE_KEY");
        return true;
    }
    false
}

/// The base provider configuration for these answers. Monitor credentials are added
/// after registration.
pub fn base_env(env: &mut Env, answers: &Answers) {
    env.set("PROVIDER_DOMAIN", &answers.api_host);
    env.set("WEB_CLIENT_DOMAIN", &answers.web_host);
    env.set("NATIVE_ADDRESS_DOMAIN", &answers.web_host);
    env.set("PROVIDER_ID", &answers.provider_id);
    env.set(
        "PLC_PROVIDER_OPERATORS",
        &format!("[\"{}-operator\"]", answers.provider_id),
    );
    env.ensure("DB_PASSWORD", secret);
    env.ensure("KEY_ENCRYPTION_KEY", secret);
    env.ensure("PUBLIC_SELF_SERVICE_ONBOARDING", || "false".into());
    env.ensure("PUBLIC_ALPHA_SIGNUP", || "false".into());
    env.ensure("HAIL_WEB_CLIENT_NAME", || "Hail".into());
    env.ensure("HAIL_WEB_CLIENT_FAVICON_PATH", || "/favicon.svg".into());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answers() -> Answers {
        Answers {
            api_host: "svr.example.org".into(),
            web_host: "example.org".into(),
            provider_id: "example".into(),
            operator_email: "ops@example.org".into(),
            monitor_api: DEFAULT_MONITOR_API.into(),
            secrets_to_file: false,
        }
    }

    #[test]
    fn validates_answers() {
        answers().check().unwrap();
        for bad in [
            Answers {
                api_host: "Svr.Example.org".into(),
                ..answers()
            },
            Answers {
                web_host: "svr.example.org".into(),
                ..answers()
            },
            Answers {
                web_host: "localhost".into(),
                ..answers()
            },
            Answers {
                provider_id: "1example".into(),
                ..answers()
            },
            Answers {
                operator_email: "not-an-email".into(),
                ..answers()
            },
            Answers {
                monitor_api: "http://enroll.example.org".into(),
                ..answers()
            },
        ] {
            assert!(bad.check().is_err(), "{bad:?}");
        }
        let parsed: Answers = toml::from_str(
            "api_host = \"svr.example.org\"\nweb_host = \"example.org\"\nprovider_id = \"example\"\noperator_email = \"ops@example.org\"\n",
        )
        .unwrap();
        assert_eq!(parsed, answers());
        assert!(toml::from_str::<Answers>("api_host = \"a.b\"\nunknown = 1\n").is_err());
    }

    #[test]
    fn keeps_existing_secrets_and_edits_in_place() {
        let mut env = Env::default();
        base_env(&mut env, &answers());
        let key = env.get("KEY_ENCRYPTION_KEY").unwrap().to_string();
        assert_eq!(key.len(), 43);
        assert_ne!(env.get("DB_PASSWORD"), Some(key.as_str()));
        assert_eq!(
            env.get("PLC_PROVIDER_OPERATORS"),
            Some("[\"example-operator\"]")
        );
        let mut reloaded = Env::parse(&env.render()).unwrap();
        base_env(
            &mut reloaded,
            &Answers {
                provider_id: "renamed".into(),
                ..answers()
            },
        );
        assert_eq!(reloaded.get("KEY_ENCRYPTION_KEY"), Some(key.as_str()));
        assert_eq!(reloaded.get("PROVIDER_ID"), Some("renamed"));
        assert!(Env::parse("NOEQUALS\n").is_err());
    }

    #[test]
    fn starts_with_signup_off_and_repairs_0_2_0_configuration() {
        let mut env = Env::default();
        base_env(&mut env, &answers());
        // The provider refuses an invitation key while signup is off.
        assert_eq!(env.get("PUBLIC_ALPHA_SIGNUP"), Some("false"));
        assert_eq!(env.get("ALPHA_SIGNUP_INVITE_KEY"), None);
        assert!(!repair_env(&mut env));
        env.set("ALPHA_SIGNUP_INVITE_KEY", "k");
        assert!(repair_env(&mut env));
        assert_eq!(env.get("ALPHA_SIGNUP_INVITE_KEY"), None);
        env.set("PUBLIC_ALPHA_SIGNUP", "true");
        env.set("ALPHA_SIGNUP_INVITE_KEY", "k");
        assert!(!repair_env(&mut env));
    }

    #[test]
    fn writes_private_files() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(&dir.path().join("hail"));
        State {
            registered: true,
            ..State::default()
        }
        .save(&paths)
        .unwrap();
        assert_eq!(
            fs::metadata(paths.state()).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&paths.dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert!(State::load(&paths).unwrap().registered);
    }
}
