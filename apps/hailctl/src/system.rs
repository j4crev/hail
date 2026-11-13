//! Root setup, done once by the verified binary that install.sh downloaded: packages,
//! the unprivileged `hail` user with its own rootless Docker, and a root-owned
//! `hailctl` shim. Everything else runs as `hail`, which cannot become root: membership
//! of the normal `docker` group would be root-equivalent, a rootless daemon is not.
use crate::host::{Os, run, run_visible};
use crate::ui;
use anyhow::{Context, Result, anyhow, bail, ensure};
use std::fs;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

pub const USER: &str = "hail";
pub const SHIM: &str = "/usr/local/bin/hailctl";
pub const UNINSTALL: &str = "/usr/local/sbin/hailctl-uninstall";
const SYSCTL: &str = "/etc/sysctl.d/90-hail-provider.conf";
const PACKAGES: [&str; 8] = [
    "docker-ce",
    "docker-ce-cli",
    "containerd.io",
    "docker-compose-plugin",
    "docker-ce-rootless-extras",
    "uidmap",
    "dbus-user-session",
    "passt",
];
/// Environment the `hail` side needs from the caller; everything else is reset.
const PASSED: [&str; 5] = [
    "TERM",
    "LANG",
    "HAILCTL_OPERATOR_CODE",
    "HAILCTL_KEY_ENCRYPTION_KEY",
    "HAILCTL_DEV_SKIP_PUBLIC_CHECKS",
];

#[derive(Debug, Clone, PartialEq)]
pub struct Account {
    pub uid: u32,
    pub gid: u32,
    pub home: PathBuf,
}

impl Account {
    pub fn runtime_dir(&self) -> String {
        format!("/run/user/{}", self.uid)
    }
    /// Where the `hail`-owned hailctl lives; it updates itself there.
    pub fn binary(&self) -> PathBuf {
        self.home.join(".local/bin/hailctl")
    }
}

/// The `hail` account, if it exists.
pub fn account() -> Result<Option<Account>> {
    let output = Command::new("getent").args(["passwd", USER]).output()?;
    if !output.status.success() {
        return Ok(None);
    }
    parse_passwd(&String::from_utf8_lossy(&output.stdout))
        .map(Some)
        .ok_or_else(|| anyhow!("unexpected passwd entry for {USER}"))
}

fn parse_passwd(line: &str) -> Option<Account> {
    let fields: Vec<&str> = line.trim().split(':').collect();
    if fields.len() < 7 || fields[0] != USER {
        return None;
    }
    Some(Account {
        uid: fields[2].parse().ok()?,
        gid: fields[3].parse().ok()?,
        home: PathBuf::from(fields[5]),
    })
}

/// The real uid of this process.
pub fn uid() -> u32 {
    fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| {
            status
                .lines()
                .find_map(|line| line.strip_prefix("Uid:"))
                .and_then(|rest| rest.split_whitespace().next()?.parse().ok())
        })
        .unwrap_or(u32::MAX)
}

/// The first free subordinate id range of `size` after every existing range.
fn next_subid_start(text: &str, size: u64) -> u64 {
    let end = text
        .lines()
        .filter_map(|line| {
            let mut fields = line.split(':').skip(1);
            let start: u64 = fields.next()?.parse().ok()?;
            let count: u64 = fields.next()?.parse().ok()?;
            Some(start + count)
        })
        .max()
        .unwrap_or(0);
    end.max(100_000).div_ceil(size) * size
}

fn has_subids(text: &str, account: &Account) -> bool {
    text.lines().any(|line| {
        let mut fields = line.split(':');
        let owner = fields.next().unwrap_or_default();
        let count: u64 = fields.nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
        (owner == USER || owner == account.uid.to_string()) && count >= 65_536
    })
}

/// apt without prompts (including needrestart's), output shown to the operator.
fn apt(args: &[&str]) -> Result<()> {
    let status = Command::new("apt-get")
        .arg("-q")
        .args(args)
        .env("DEBIAN_FRONTEND", "noninteractive")
        .env("NEEDRESTART_MODE", "a")
        .status()
        .context("could not run apt-get")?;
    ensure!(status.success(), "apt-get {} failed", args.join(" "));
    Ok(())
}

fn installed(package: &str) -> bool {
    run("dpkg-query", &["-W", "-f=${Status}", package])
        .is_ok_and(|status| status.trim() == "install ok installed")
}

/// Docker Engine with rootless support and its helpers, from Docker's apt repository.
fn packages(os: &Os, assume_yes: bool) -> Result<()> {
    let missing: Vec<&str> = PACKAGES.into_iter().filter(|p| !installed(p)).collect();
    if missing.is_empty() {
        ui::info("Docker Engine (rootless) and its helpers are installed.");
        return Ok(());
    }
    ensure!(
        !installed("docker.io"),
        "this server has Debian/Ubuntu's docker.io package; hailctl uses Docker's own packages (remove docker.io first)"
    );
    ensure!(
        ui::confirm(
            &format!(
                "Install {} from Docker's and {}'s apt repositories?",
                missing.join(", "),
                os.id
            ),
            assume_yes
        )?,
        "these packages are required; install them and run the installer again"
    );
    let rootful_before = installed("docker-ce");
    apt(&["update"])?;
    apt(&["install", "-y", "ca-certificates", "curl"])?;
    run_visible("install", &["-m", "0755", "-d", "/etc/apt/keyrings"])?;
    let key = format!("https://download.docker.com/linux/{}/gpg", os.id);
    run_visible(
        "curl",
        &[
            "-fsSL",
            "--proto",
            "=https",
            &key,
            "-o",
            "/etc/apt/keyrings/docker.asc",
        ],
    )?;
    run_visible("chmod", &["a+r", "/etc/apt/keyrings/docker.asc"])?;
    let architecture = run("dpkg", &["--print-architecture"])?;
    fs::write(
        "/etc/apt/sources.list.d/docker.sources",
        format!(
            "Types: deb\nURIs: https://download.docker.com/linux/{}\nSuites: {}\nComponents: stable\nArchitectures: {}\nSigned-By: /etc/apt/keyrings/docker.asc\n",
            os.id,
            os.codename,
            architecture.trim()
        ),
    )?;
    apt(&["update"])?;
    let mut args = vec!["install", "-y"];
    args.extend(PACKAGES);
    apt(&args)?;
    if !rootful_before {
        // Installed only for this provider, so the root daemon is not needed: leaving it
        // running would leave a root-equivalent socket on the server.
        run(
            "systemctl",
            &["disable", "--now", "docker.socket", "docker.service"],
        )?;
        ui::info("The system Docker daemon is disabled; the provider uses its own rootless one.");
    }
    Ok(())
}

fn create_user() -> Result<Account> {
    if let Some(account) = account()? {
        return Ok(account);
    }
    run_visible(
        "useradd",
        &[
            "--create-home",
            "--shell",
            "/bin/bash",
            "--comment",
            "Hail provider",
            USER,
        ],
    )?;
    let account = account()?.ok_or_else(|| anyhow!("{USER} was not created"))?;
    ui::info(&format!("Created the {USER} user (uid {}).", account.uid));
    Ok(account)
}

fn subids(account: &Account) -> Result<()> {
    for (file, flag) in [
        ("/etc/subuid", "--add-subuids"),
        ("/etc/subgid", "--add-subgids"),
    ] {
        let text = fs::read_to_string(file).unwrap_or_default();
        if !has_subids(&text, account) {
            let start = next_subid_start(&text, 65_536);
            run(
                "usermod",
                &[flag, &format!("{start}-{}", start + 65_535), USER],
            )?;
        }
    }
    Ok(())
}

/// Lets unprivileged processes bind ports 80 and 443 (Caddy, through rootless Docker).
fn low_ports() -> Result<()> {
    fs::write(
        SYSCTL,
        "# Installed by hailctl: rootless Docker publishes the provider's ports 80 and 443.\nnet.ipv4.ip_unprivileged_port_start=80\n",
    )?;
    run(
        "sysctl",
        &["-q", "-w", "net.ipv4.ip_unprivileged_port_start=80"],
    )?;
    Ok(())
}

/// A file owned by the `hail` account.
fn write_owned(account: &Account, path: &Path, contents: &[u8], mode: u32) -> Result<()> {
    if let Some(parent) = path.parent() {
        owned_dir(account, parent, 0o755)?;
    }
    let temporary = path.with_extension("new");
    {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(mode)
            .open(&temporary)?;
        file.write_all(contents)?;
        file.sync_all()?;
    }
    fs::set_permissions(&temporary, fs::Permissions::from_mode(mode))?;
    std::os::unix::fs::chown(&temporary, Some(account.uid), Some(account.gid))?;
    fs::rename(&temporary, path)?;
    Ok(())
}

/// Creates `path` and any missing parents under the home directory, owned by `hail`.
fn owned_dir(account: &Account, path: &Path, mode: u32) -> Result<()> {
    if path.is_dir() {
        return Ok(());
    }
    if let Some(parent) = path.parent()
        && parent.starts_with(&account.home)
        && parent != account.home
    {
        owned_dir(account, parent, 0o755)?;
    }
    fs::create_dir(path).with_context(|| format!("cannot create {}", path.display()))?;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    std::os::unix::fs::chown(path, Some(account.uid), Some(account.gid))?;
    Ok(())
}

pub fn docker_unit() -> &'static str {
    // As dockerd-rootless-setuptool.sh writes it, with pasta networking: it keeps the
    // client's real address on published ports, which rate limits depend on.
    "[Unit]\nDescription=Docker Application Container Engine (Rootless, Hail provider)\nDocumentation=https://docs.docker.com/go/rootless/\n\n[Service]\nEnvironment=PATH=/usr/bin:/sbin:/usr/sbin:/bin\nEnvironment=DOCKERD_ROOTLESS_ROOTLESSKIT_NET=pasta\nEnvironment=DOCKERD_ROOTLESS_ROOTLESSKIT_PORT_DRIVER=implicit\nExecStart=/usr/bin/dockerd-rootless.sh\nExecReload=/bin/kill -s HUP $MAINPID\nTimeoutSec=0\nRestartSec=2\nRestart=always\nStartLimitBurst=3\nStartLimitInterval=60s\nLimitNOFILE=infinity\nLimitNPROC=infinity\nLimitCORE=infinity\nTasksMax=infinity\nDelegate=yes\nType=notify\nNotifyAccess=all\nKillMode=mixed\n\n[Install]\nWantedBy=default.target\n"
}

fn wait_for(what: &str, seconds: u64, mut ready: impl FnMut() -> bool) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(seconds);
    while !ready() {
        ensure!(Instant::now() < deadline, "{what} did not start");
        std::thread::sleep(Duration::from_millis(500));
    }
    Ok(())
}

/// Runs the user's systemd manager at boot and starts its rootless Docker daemon.
fn rootless_docker(account: &Account) -> Result<()> {
    run("loginctl", &["enable-linger", USER])?;
    let bus = PathBuf::from(account.runtime_dir()).join("bus");
    wait_for("the hail user's session", 60, || bus.exists())?;
    write_owned(
        account,
        &account.home.join(".config/systemd/user/docker.service"),
        docker_unit().as_bytes(),
        0o644,
    )?;
    let machine = format!("{USER}@");
    run("systemctl", &["--user", "-M", &machine, "daemon-reload"])?;
    run(
        "systemctl",
        &[
            "--user",
            "-M",
            &machine,
            "enable",
            "--now",
            "docker.service",
        ],
    )?;
    wait_for("rootless Docker", 120, || {
        as_user(
            account,
            "docker",
            &["info", "--format", "{{.ServerVersion}}"],
        )
        .output()
        .is_ok_and(|o| o.status.success())
    })?;
    ui::info("Rootless Docker is running for the hail user.");
    Ok(())
}

/// A command run as `hail` with a clean environment pointing at its own Docker.
pub fn as_user(account: &Account, program: &str, args: &[&str]) -> Command {
    let mut command = Command::new("runuser");
    command
        .args(["-u", USER, "--", "env", "-i"])
        .args(user_environment(account))
        .arg(program)
        .args(args);
    command
}

fn user_environment(account: &Account) -> Vec<String> {
    let runtime = account.runtime_dir();
    let mut variables = vec![
        "PATH=/usr/local/bin:/usr/bin:/bin".to_string(),
        format!("HOME={}", account.home.display()),
        format!("USER={USER}"),
        format!("LOGNAME={USER}"),
        format!("XDG_RUNTIME_DIR={runtime}"),
        format!("DBUS_SESSION_BUS_ADDRESS=unix:path={runtime}/bus"),
        format!("DOCKER_HOST=unix://{runtime}/docker.sock"),
    ];
    for name in PASSED {
        if let Ok(value) = std::env::var(name) {
            variables.push(format!("{name}={value}"));
        }
    }
    variables
}

/// The root-owned `hailctl` on root's PATH. Root switches to `hail` before running the
/// `hail`-owned binary, so a modified binary can never run as root.
pub fn shim(account: &Account) -> String {
    let runtime = account.runtime_dir();
    let passed: String = PASSED
        .iter()
        .map(|name| format!(" ${{{name}:+\"{name}=${name}\"}}"))
        .collect();
    format!(
        "#!/bin/sh\n# Installed by hailctl. The provider is managed by the unprivileged {USER} user; root\n# switches to it first, so the {USER}-owned binary never runs as root.\nbin='{bin}'\ncase \"$(id -u)\" in\n  0) exec runuser -u {USER} -- env -i PATH=/usr/local/bin:/usr/bin:/bin HOME='{home}' USER={USER} LOGNAME={USER} \\\n       XDG_RUNTIME_DIR={runtime} DBUS_SESSION_BUS_ADDRESS=unix:path={runtime}/bus DOCKER_HOST=unix://{runtime}/docker.sock \\\n      {passed} \"$bin\" \"$@\" ;;\n  {uid}) exec \"$bin\" \"$@\" ;;\n  *) echo \"hailctl: run as root (sudo hailctl ...) or as the {USER} user\" >&2; exit 1 ;;\nesac\n",
        bin = account.binary().display(),
        home = account.home.display(),
        uid = account.uid,
    )
}

/// Root's half of decommissioning, after `hailctl decommission` (as `hail`) deleted the
/// provider: removes everything the root setup created except the packages.
pub fn uninstall_script(account: &Account, dir: &Path) -> String {
    format!(
        r#"#!/bin/sh
# Installed by hailctl. After `sudo hailctl decommission`, removes what the installer's
# root setup created: the {user} user with its rootless Docker data, {dir}, hailctl and
# the low-port setting. Docker Engine and the other packages stay installed.
set -eu
[ "$(id -u)" -eq 0 ] || {{ echo "hailctl-uninstall: run as root" >&2; exit 1; }}
dir='{dir}'
home='{home}'
uid={uid}
if [ "${{1:-}}" != --force ] && [ -d "$dir" ] && [ ! -f "$dir/{marker}" ]; then
  echo "hailctl-uninstall: run 'sudo hailctl decommission' first (or --force deletes the provider without a final backup or deregistration)" >&2
  exit 1
fi
keep=/root/hail-provider-final-backups
if ls "$home"/decommissioned/*.tar.age >/dev/null 2>&1; then
  mkdir -p "$keep" && chmod 0700 "$keep"
  mv "$home"/decommissioned/*.tar.age "$keep"/
  echo "Kept the final backup in $keep."
fi
loginctl disable-linger {user} 2>/dev/null || true
systemctl stop "user@$uid.service" 2>/dev/null || true
pkill -KILL -u {user} 2>/dev/null || true
userdel --remove {user} 2>/dev/null || userdel {user} 2>/dev/null || true
rm -rf "$home" "$dir" {shim} {sysctl}
sysctl -q -w net.ipv4.ip_unprivileged_port_start=1024 || true
rm -f "$0"
echo "Removed the {user} user, its rootless Docker data, $dir and hailctl."
echo "Docker Engine is still installed; remove it with apt-get purge if nothing else uses it."
"#,
        user = USER,
        dir = dir.display(),
        home = account.home.display(),
        uid = account.uid,
        marker = crate::decommission::MARKER,
        shim = SHIM,
        sysctl = SYSCTL,
    )
}

/// The install directory, owned by `hail`. A directory owned by anyone else belongs to a
/// root-mode installation (hailctl 0.3) and is not adopted.
fn install_dir(account: &Account, dir: &Path) -> Result<()> {
    if dir.exists() {
        let owner = fs::metadata(dir)?.uid();
        ensure!(
            owner == account.uid,
            "{} belongs to another installation (owner uid {owner}); hailctl now runs as the {USER} user and does not adopt it",
            dir.display()
        );
        return Ok(());
    }
    fs::create_dir_all(dir)?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    std::os::unix::fs::chown(dir, Some(account.uid), Some(account.gid))?;
    Ok(())
}

/// Copies a file the operator named into the install directory, so `hail` can read it.
pub fn hand_over(account: &Account, dir: &Path, file: &Path) -> Result<PathBuf> {
    let name = file
        .file_name()
        .ok_or_else(|| anyhow!("{} is not a file", file.display()))?;
    let target = dir.join("incoming").join(name);
    let contents = fs::read(file).with_context(|| format!("cannot read {}", file.display()))?;
    if !target.parent().is_some_and(Path::is_dir) {
        let parent = dir.join("incoming");
        fs::create_dir(&parent)?;
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o700))?;
        std::os::unix::fs::chown(&parent, Some(account.uid), Some(account.gid))?;
    }
    write_owned(account, &target, &contents, 0o600)?;
    Ok(target)
}

/// The root part of `hailctl install`. Idempotent: running the installer again repairs
/// the setup and replaces the `hail`-owned binary with this verified one.
pub fn bootstrap(os: &Os, dir: &Path, assume_yes: bool) -> Result<Account> {
    let executable = std::env::current_exe()?;
    if let Some(existing) = account()? {
        // Root must not run a binary the hail user could have modified.
        ensure!(
            fs::metadata(&executable)?.uid() != existing.uid,
            "run the installer (curl -fsSL https://get.racrproto.com | sh), not the {USER} user's hailctl, as root"
        );
    }
    ui::step("Preparing this server");
    packages(os, assume_yes)?;
    let account = create_user()?;
    subids(&account)?;
    low_ports()?;
    rootless_docker(&account)?;
    install_dir(&account, dir)?;
    write_owned(
        &account,
        &account.binary(),
        &fs::read(&executable).context("cannot read this hailctl")?,
        0o755,
    )?;
    let shim = shim(&account);
    let staged = format!("{SHIM}.new");
    fs::write(&staged, shim)?;
    fs::set_permissions(&staged, fs::Permissions::from_mode(0o755))?;
    std::os::unix::fs::chown(&staged, Some(0), Some(0))?;
    fs::rename(&staged, SHIM)?;
    let staged = format!("{UNINSTALL}.new");
    fs::write(&staged, uninstall_script(&account, dir))?;
    fs::set_permissions(&staged, fs::Permissions::from_mode(0o700))?;
    std::os::unix::fs::chown(&staged, Some(0), Some(0))?;
    fs::rename(&staged, UNINSTALL)?;
    ui::info(&format!(
        "Installed hailctl for the {USER} user; run it as `sudo hailctl ...` or as {USER}."
    ));
    Ok(account)
}

/// Continues as `hail`: the rest of the install never needs root.
pub fn continue_as_user(account: &Account, args: &[String]) -> Result<()> {
    let binary = account.binary();
    let mut command = as_user(account, &binary.to_string_lossy(), &[]);
    command.args(args);
    let status = command
        .status()
        .context("could not switch to the hail user")?;
    if !status.success() {
        bail!("the installation stopped; run the installer again to resume");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hail() -> Account {
        Account {
            uid: 1001,
            gid: 1001,
            home: PathBuf::from("/home/hail"),
        }
    }

    #[test]
    fn parses_the_account() {
        assert_eq!(
            parse_passwd("hail:x:1001:1001:Hail provider:/home/hail:/bin/bash\n"),
            Some(hail())
        );
        assert_eq!(parse_passwd("other:x:1:1::/:/bin/sh"), None);
        assert_eq!(
            hail().binary(),
            PathBuf::from("/home/hail/.local/bin/hailctl")
        );
    }

    #[test]
    fn allocates_subordinate_ids_after_existing_ranges() {
        assert_eq!(next_subid_start("", 65_536), 131_072);
        assert_eq!(
            next_subid_start("ubuntu:100000:65536\nops:165536:65536\n", 65_536),
            262_144
        );
        assert!(has_subids("hail:165536:65536\n", &hail()));
        assert!(has_subids("1001:165536:65536\n", &hail()));
        assert!(!has_subids("hail:165536:1000\n", &hail()));
        assert!(!has_subids("other:165536:65536\n", &hail()));
    }

    #[test]
    fn the_shim_switches_root_to_hail_before_running_the_binary() {
        let shim = shim(&hail());
        assert!(shim.starts_with("#!/bin/sh\n"));
        assert!(shim.contains("0) exec runuser -u hail -- env -i"));
        assert!(shim.contains("DOCKER_HOST=unix:///run/user/1001/docker.sock"));
        assert!(shim.contains("1001) exec \"$bin\" \"$@\""));
        assert!(shim.contains("bin='/home/hail/.local/bin/hailctl'"));
        assert!(shim.contains(
            "${HAILCTL_OPERATOR_CODE:+\"HAILCTL_OPERATOR_CODE=$HAILCTL_OPERATOR_CODE\"}"
        ));
    }

    #[test]
    fn the_uninstaller_requires_a_decommissioned_provider() {
        let script = uninstall_script(&hail(), Path::new("/opt/hail-provider"));
        assert!(script.starts_with("#!/bin/sh\n"));
        assert!(script.contains("dir='/opt/hail-provider'"));
        assert!(script.contains("[ ! -f \"$dir/DECOMMISSIONED\" ]"));
        assert!(script.contains("userdel --remove hail"));
        assert!(script.contains(
            "rm -rf \"$home\" \"$dir\" /usr/local/bin/hailctl /etc/sysctl.d/90-hail-provider.conf"
        ));
    }

    #[test]
    fn the_rootless_daemon_keeps_client_addresses() {
        assert!(docker_unit().contains("DOCKERD_ROOTLESS_ROOTLESSKIT_NET=pasta"));
        assert!(docker_unit().contains("DOCKERD_ROOTLESS_ROOTLESSKIT_PORT_DRIVER=implicit"));
    }
}
