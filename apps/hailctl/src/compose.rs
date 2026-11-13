//! Docker Compose for the installed release: the release's Compose files, the
//! operator `.env`, and the release's image pins (which always win).
use crate::state::{Env, Ingress, Paths};
use anyhow::{Context, Result, ensure};
use std::fs::File;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::process::{Command, Stdio};

/// Whether the email bridge's converter runs (its database role exists).
fn bridge_ready(paths: &Paths) -> bool {
    Env::load(&paths.env()).is_ok_and(|env| env.get(crate::bridge::READY) == Some("on"))
}

/// Whether this installation reaches the internet through a Cloudflare Tunnel.
pub fn tunnel(paths: &Paths) -> bool {
    Env::load(&paths.env())
        .is_ok_and(|env| env.get("HAIL_INGRESS") == Some(Ingress::CloudflareTunnel.as_str()))
}

pub struct Compose {
    args: Vec<String>,
    /// The email bridge's converter is part of this deployment.
    bridge: bool,
}

impl Compose {
    pub fn new(paths: &Paths) -> Compose {
        let release = paths.release();
        let path = |name: &str| release.join(name).to_string_lossy().into_owned();
        Compose {
            bridge: bridge_ready(paths),
            args: vec![
                "compose".into(),
                "--project-directory".into(),
                release.to_string_lossy().into_owned(),
                "--env-file".into(),
                paths.env().to_string_lossy().into_owned(),
                // Later env files override earlier ones: the signed release's image pins win.
                "--env-file".into(),
                path("release.env"),
                "-f".into(),
                path("compose.yaml"),
                "-f".into(),
                path("compose.web-client.yaml"),
            ]
            .into_iter()
            .chain(
                tunnel(paths)
                    .then(|| ["-f".to_string(), path("compose.tunnel.yaml")])
                    .into_iter()
                    .flatten(),
            )
            .chain(
                bridge_ready(paths)
                    .then(|| ["--profile".to_string(), "email-bridge".to_string()])
                    .into_iter()
                    .flatten(),
            )
            .collect(),
        }
    }

    fn command(&self, extra: &[&str]) -> Command {
        let mut command = Command::new("docker");
        command.args(&self.args).args(extra);
        command
    }

    /// Runs with output shown to the operator.
    pub fn run(&self, extra: &[&str]) -> Result<()> {
        let status = self
            .command(extra)
            .status()
            .context("could not run docker compose")?;
        ensure!(
            status.success(),
            "docker compose {} failed",
            extra.join(" ")
        );
        Ok(())
    }

    /// Runs and returns standard output; errors still reach the operator.
    pub fn output(&self, extra: &[&str]) -> Result<String> {
        let output = self
            .command(extra)
            .stderr(Stdio::inherit())
            .output()
            .context("could not run docker compose")?;
        ensure!(
            output.status.success(),
            "docker compose {} failed",
            extra.join(" ")
        );
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    /// Runs, streaming standard output into a new private file.
    pub fn to_file(&self, extra: &[&str], path: &Path) -> Result<()> {
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)?;
        let status = self
            .command(extra)
            .stdout(file)
            .status()
            .context("could not run docker compose")?;
        ensure!(
            status.success(),
            "docker compose {} failed",
            extra.join(" ")
        );
        ensure!(
            path.metadata()?.len() > 0,
            "docker compose {} produced no output",
            extra.join(" ")
        );
        Ok(())
    }

    /// Runs with standard input read from a file, discarding standard output.
    pub fn feed_file(&self, extra: &[&str], path: &Path) -> Result<()> {
        let status = self
            .command(extra)
            .stdin(File::open(path)?)
            .stdout(Stdio::null())
            .status()
            .context("could not run docker compose")?;
        ensure!(
            status.success(),
            "docker compose {} failed",
            extra.join(" ")
        );
        Ok(())
    }

    /// Runs with standard input from memory; returns standard output.
    pub fn input(&self, extra: &[&str], input: &[u8]) -> Result<String> {
        use std::io::Write;
        let mut child = self
            .command(extra)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .context("could not run docker compose")?;
        child.stdin.take().expect("piped stdin").write_all(input)?;
        let output = child.wait_with_output()?;
        ensure!(
            output.status.success(),
            "docker compose {} failed",
            extra.join(" ")
        );
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    /// Stops the services that write to the database. PostgreSQL and Caddy keep running.
    pub fn stop_writers(&self) -> Result<()> {
        // The email bridge's converter, when it runs, writes too.
        if self.bridge {
            self.run(&["stop", "provider", "web-client", "email-converter"])
        } else {
            self.run(&["stop", "provider", "web-client"])
        }
    }

    /// Runs a provider command (from its image's working directory) and parses its JSON output.
    pub fn provider_json(&self, args: &[&str]) -> Result<serde_json::Value> {
        let mut extra = vec!["exec", "-T", "provider", "bun"];
        extra.extend_from_slice(args);
        let output = self.output(&extra)?;
        serde_json::from_str(output.trim())
            .with_context(|| format!("unexpected output from {}", args.join(" ")))
    }

    pub fn up(&self) -> Result<()> {
        self.run(&["pull", "--quiet"])?;
        self.run(&["up", "-d", "--wait", "--remove-orphans"])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_the_tunnel_overlay_only_for_tunnel_ingress() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path());
        let files = |compose: &Compose| -> Vec<String> {
            compose
                .args
                .windows(2)
                .filter(|pair| pair[0] == "-f")
                .map(|pair| pair[1].rsplit('/').next().unwrap().to_string())
                .collect()
        };
        assert_eq!(
            files(&Compose::new(&paths)),
            ["compose.yaml", "compose.web-client.yaml"]
        );
        std::fs::write(paths.env(), "HAIL_INGRESS=cloudflare-tunnel\n").unwrap();
        assert_eq!(
            files(&Compose::new(&paths)),
            [
                "compose.yaml",
                "compose.web-client.yaml",
                "compose.tunnel.yaml"
            ]
        );
    }
}
