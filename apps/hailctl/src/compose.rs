//! Docker Compose for the installed release: the release's Compose files, the
//! operator `.env`, and the release's image pins (which always win).
use crate::state::Paths;
use anyhow::{Context, Result, ensure};
use std::process::{Command, Stdio};

pub struct Compose {
    args: Vec<String>,
}

impl Compose {
    pub fn new(paths: &Paths) -> Compose {
        let release = paths.release();
        let path = |name: &str| release.join(name).to_string_lossy().into_owned();
        Compose {
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
            ],
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
