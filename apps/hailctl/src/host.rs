//! Host preflight and Docker installation.
use anyhow::{Context, Result, bail, ensure};
use std::collections::HashMap;
use std::fs;
use std::net::TcpListener;
use std::process::{Command, Stdio};

/// Supported hosts for v1: the latest Ubuntu LTS and Debian stable.
pub const SUPPORTED: [(&str, &str, &str); 2] = [
    ("ubuntu", "26.04", "Ubuntu 26.04 LTS"),
    ("debian", "13", "Debian 13"),
];
const MIN_MEMORY_MIB: u64 = 1900;
const MIN_DISK_GIB: u64 = 10;

#[derive(Debug, Clone, PartialEq)]
pub struct Os {
    pub id: String,
    pub version: String,
    pub codename: String,
}

pub fn parse_os_release(text: &str) -> HashMap<String, String> {
    text.lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| {
            (
                key.trim().to_string(),
                value.trim().trim_matches('"').to_string(),
            )
        })
        .collect()
}

/// The host OS, if it is a supported release.
pub fn supported_os(fields: &HashMap<String, String>) -> Result<Os> {
    let id = fields.get("ID").cloned().unwrap_or_default();
    let version = fields.get("VERSION_ID").cloned().unwrap_or_default();
    let codename = fields.get("VERSION_CODENAME").cloned().unwrap_or_default();
    if !SUPPORTED.iter().any(|(i, v, _)| *i == id && *v == version) || codename.is_empty() {
        let names: Vec<&str> = SUPPORTED.iter().map(|(_, _, name)| *name).collect();
        bail!(
            "{} is not supported; use {}",
            fields.get("PRETTY_NAME").map_or("This OS", |s| s),
            names.join(" or ")
        );
    }
    Ok(Os {
        id,
        version,
        codename,
    })
}

pub fn run(program: &str, args: &[&str]) -> Result<String> {
    let output = Command::new(program)
        .args(args)
        .stderr(Stdio::inherit())
        .output()
        .with_context(|| format!("could not run {program}"))?;
    ensure!(
        output.status.success(),
        "{program} {} failed",
        args.join(" ")
    );
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Runs a command with its output shown to the operator.
pub fn run_visible(program: &str, args: &[&str]) -> Result<()> {
    let status = Command::new(program)
        .args(args)
        .status()
        .with_context(|| format!("could not run {program}"))?;
    ensure!(status.success(), "{program} {} failed", args.join(" "));
    Ok(())
}

fn memory_mib() -> Result<u64> {
    let meminfo = fs::read_to_string("/proc/meminfo")?;
    let kib: u64 = meminfo
        .lines()
        .find_map(|line| line.strip_prefix("MemTotal:"))
        .and_then(|rest| rest.split_whitespace().next()?.parse().ok())
        .context("could not read total memory")?;
    Ok(kib / 1024)
}

/// Free bytes on the filesystem holding `path`.
pub fn available_bytes(path: &std::path::Path) -> Result<u64> {
    let output = run("df", &["-Pk", &path.to_string_lossy()])?;
    let kib: u64 = output
        .lines()
        .nth(1)
        .and_then(|line| line.split_whitespace().nth(3)?.parse().ok())
        .context("could not read free disk space")?;
    Ok(kib * 1024)
}

pub fn is_root() -> bool {
    run("id", &["-u"]).is_ok_and(|uid| uid.trim() == "0")
}

pub struct Preflight {
    pub os: Os,
    pub warnings: Vec<String>,
}

/// Checks the host, as root, before anything is installed.
pub fn preflight() -> Result<Preflight> {
    ensure!(is_root(), "run hailctl as root (for example with sudo)");
    let os = supported_os(&parse_os_release(
        &fs::read_to_string("/etc/os-release").context("cannot read /etc/os-release")?,
    ))?;
    ensure!(
        matches!(std::env::consts::ARCH, "x86_64" | "aarch64"),
        "unsupported architecture; use amd64 or arm64"
    );
    let mut warnings = Vec::new();
    let memory = memory_mib()?;
    if memory < MIN_MEMORY_MIB {
        warnings.push(format!(
            "{memory} MiB of memory; 2 GiB or more is recommended"
        ));
    }
    let disk = available_bytes(std::path::Path::new("/"))? >> 30;
    ensure!(
        disk >= MIN_DISK_GIB,
        "{disk} GiB free on /; at least {MIN_DISK_GIB} GiB is needed"
    );
    Ok(Preflight { os, warnings })
}

/// Direct ingress needs ports 80 and 443 free (checked as the `hail` user, after the root
/// setup allowed unprivileged processes to bind them).
pub fn ports_free() -> Result<()> {
    for port in [80, 443] {
        ensure!(
            TcpListener::bind(("0.0.0.0", port)).is_ok(),
            "port {port} is already in use; direct ingress runs its own HTTPS server on 80 and 443 (or choose Cloudflare Tunnel ingress)"
        );
    }
    Ok(())
}

/// Whether this user's Docker daemon answers (rootless, through DOCKER_HOST).
pub fn docker_ready() -> bool {
    run("docker", &["version", "--format", "{{.Server.Version}}"]).is_ok()
        && run("docker", &["compose", "version"]).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_supported_releases() {
        let ubuntu = parse_os_release(
            "ID=ubuntu\nVERSION_ID=\"26.04\"\nVERSION_CODENAME=resolute\nPRETTY_NAME=\"Ubuntu 26.04 LTS\"\n",
        );
        assert_eq!(
            supported_os(&ubuntu).unwrap(),
            Os {
                id: "ubuntu".into(),
                version: "26.04".into(),
                codename: "resolute".into()
            }
        );
        let debian = parse_os_release("ID=debian\nVERSION_ID=\"13\"\nVERSION_CODENAME=trixie\n");
        assert_eq!(supported_os(&debian).unwrap().codename, "trixie");
        for other in [
            "ID=ubuntu\nVERSION_ID=\"24.04\"\nVERSION_CODENAME=noble\n",
            "ID=debian\nVERSION_ID=\"12\"\nVERSION_CODENAME=bookworm\n",
            "ID=fedora\nVERSION_ID=43\n",
            "ID=ubuntu\nVERSION_ID=\"26.04\"\n",
        ] {
            assert!(supported_os(&parse_os_release(other)).is_err(), "{other}");
        }
    }
}
