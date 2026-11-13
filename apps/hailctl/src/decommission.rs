//! `hailctl decommission`: takes a provider out of service, as the `hail` user. It keeps a
//! final backup, deregisters from the shared monitor (spec/monitor-receiver.md), and
//! deletes the containers, data and configuration. The root setup is then removed by
//! `hailctl-uninstall`, which the installer put in place.
use crate::backup::{self, Reason};
use crate::compose::Compose;
use crate::install::owned_by_me;
use crate::state::{self, Answers, Env, Ingress, Paths, State};
use crate::{release, system, ui};
use anyhow::{Context, Result, anyhow, bail, ensure};
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const MARKER: &str = "DECOMMISSIONED";

pub struct Options {
    pub dir: PathBuf,
    /// Non-interactive confirmation: the provider ID.
    pub confirm: Option<String>,
    pub no_backup: bool,
    /// Leave the monitor registration in place (for example when the monitor cannot be
    /// reached; its operator can retire it).
    pub skip_monitor: bool,
}

/// Active accounts other than provider service accounts.
fn user_accounts(compose: &Compose) -> Option<u64> {
    compose
        .output(&[
            "exec", "-T", "db", "psql", "-X", "-U", "hail", "-d", "hail", "-Atq", "-c",
            "SELECT count(*) FROM provider_accounts a WHERE a.onboarding_state='active' AND NOT EXISTS \
             (SELECT 1 FROM provider_service_account_evidence e WHERE e.account_id=a.id)",
        ])
        .ok()?
        .trim()
        .parse()
        .ok()
}

#[derive(Debug, PartialEq)]
pub enum Deregistered {
    Done {
        stopped: u64,
    },
    /// The monitor no longer knows the credential: already deregistered or replaced.
    Unknown,
}

/// `POST /api/v1/providers/deregister` with the provider's monitor credential.
pub fn deregister(answers: &Answers, token: &str) -> Result<Deregistered> {
    let url = format!("{}/api/v1/providers/deregister", answers.monitor_api);
    let body = json!({ "providerOrigin": answers.api_origin() }).to_string();
    let mut attempt = 0;
    loop {
        attempt += 1;
        let response = release::agent()
            .post(&url)
            .set("Content-Type", "application/json")
            .set("Authorization", &format!("Bearer {token}"))
            .send_string(&body);
        let (status, value) = match response {
            Ok(response) => (
                response.status(),
                response.into_json::<Value>().unwrap_or(Value::Null),
            ),
            Err(ureq::Error::Status(status, response)) => {
                (status, response.into_json::<Value>().unwrap_or(Value::Null))
            }
            Err(error) => return Err(anyhow!("could not reach the monitor: {error}")),
        };
        let reason = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("no details");
        match status {
            200 => {
                return Ok(Deregistered::Done {
                    stopped: value["stoppedIdentities"].as_u64().unwrap_or(0),
                });
            }
            401 => return Ok(Deregistered::Unknown),
            // Retired, but the receiver is not updated yet; a retry completes it.
            503 if attempt < 5 => std::thread::sleep(Duration::from_secs(5)),
            _ => bail!("the monitor refused deregistration ({status}): {reason}"),
        }
    }
}

fn confirm(options: &Options, provider_id: &str) -> Result<()> {
    if let Some(given) = &options.confirm {
        ensure!(
            given == provider_id,
            "--confirm must be this provider's ID ({provider_id})"
        );
        return Ok(());
    }
    ensure!(
        ui::interactive(),
        "no terminal is attached; pass --confirm {provider_id}"
    );
    let typed = inquire::Text::new(&format!(
        "Type the provider ID ({provider_id}) to decommission it:"
    ))
    .prompt()
    .context("cancelled")?;
    ensure!(
        typed.trim() == provider_id,
        "not confirmed; nothing changed"
    );
    Ok(())
}

/// Things outside this server that only the operator can remove.
fn external_cleanup(answers: &Answers, paths: &Paths) -> Vec<String> {
    let mut items = Vec::new();
    match answers.ingress {
        Ingress::Direct => items.push(format!(
            "DNS: the A/AAAA records of {} and {}",
            answers.api_host, answers.web_host
        )),
        Ingress::CloudflareTunnel => items.push(format!(
            "Cloudflare: the tunnel and its public hostnames {} and {}",
            answers.api_host, answers.web_host
        )),
    }
    items.push(format!(
        "DNS: the TXT record _hail-provider.{}",
        answers.web_host
    ));
    if let Some(domain) = &answers.email_bridge_domain {
        items.push(format!(
            "Email bridge: the {domain} Email Routing catch-all and the email Worker, its R2 buckets and queue"
        ));
    }
    if let Ok(Some(remote)) = backup::load_remote(paths) {
        items.push(format!(
            "Backups: the copies in {}/{}/{} (keep or delete them)",
            remote.endpoint, remote.bucket, remote.prefix
        ));
    }
    items.push(
        "Identities: this provider's PLC identities stay in the public directory; they cannot be deleted"
            .into(),
    );
    items
}

pub fn decommission(options: &Options) -> Result<()> {
    ensure!(
        !crate::host::is_root(),
        "run `sudo hailctl decommission` (the shim switches to the {} user) or run it as {}",
        system::USER,
        system::USER
    );
    let paths = Paths::new(&options.dir);
    ensure!(
        paths.dir.is_dir() && owned_by_me(&paths.dir),
        "{} is not this user's provider",
        paths.dir.display()
    );
    ensure!(
        !paths.dir.join(MARKER).exists(),
        "this provider is already decommissioned; run `sudo hailctl-uninstall` to remove the rest"
    );
    let _lock = state::lock(&paths, false)?;
    let state = State::load(&paths)?;
    let answers = state.answers.clone();
    let provider_id = answers
        .as_ref()
        .map_or_else(|| "unconfigured".to_string(), |a| a.provider_id.clone());
    let running = paths.release().join("compose.yaml").is_file() && state.configured;
    let compose = running.then(|| Compose::new(&paths));

    ui::step(&format!("Decommissioning {provider_id}"));
    ui::info("This deletes the provider's containers, database, configuration and secrets.");
    if state.started && !options.no_backup {
        ui::info("A final backup is kept first (encrypted with KEY_ENCRYPTION_KEY).");
    }
    if state.registered && !options.skip_monitor {
        ui::info("Its registration with the shared monitor is removed: monitoring of its");
        ui::info("users' identities stops, and the provider can register again later.");
    }
    if let Some(users) = compose.as_ref().and_then(user_accounts)
        && users > 0
    {
        ui::info(&format!(
            "Warning: {users} user account(s) are active. Their users lose them unless they move to another provider first."
        ));
    }
    confirm(options, &provider_id)?;

    let mut kept = None;
    if let Some(compose) = &compose
        && state.started
        && !options.no_backup
    {
        ui::step("Final backup");
        let created = backup::create(&paths, &state, compose, Reason::Manual)?;
        if let Some(remote) = backup::load_remote(&paths)? {
            match remote.upload(&created.path, &created.name) {
                Ok(()) => ui::info("Copied to the bucket and read back."),
                Err(error) => ui::info(&format!("Warning: not copied off-host ({error:#}).")),
            }
        }
        // Outside the install directory, which is deleted; hailctl-uninstall moves it to root.
        let home = PathBuf::from(std::env::var("HOME").context("HOME is not set")?);
        let target = home.join("decommissioned").join(&created.name);
        fs::create_dir_all(target.parent().expect("has a parent"))?;
        fs::rename(&created.path, &target)?;
        ui::info(&format!("Kept {}.", target.display()));
        kept = Some(target);
    }

    if let Some(answers) = &answers
        && state.registered
        && !options.skip_monitor
    {
        ui::step("Leaving the shared monitor");
        let env = Env::load(&paths.env())?;
        let token = env
            .get("SIGNUP_MONITOR_TOKEN")
            .ok_or_else(|| anyhow!("{} has no SIGNUP_MONITOR_TOKEN", paths.env().display()))?;
        match deregister(answers, token)? {
            Deregistered::Done { stopped } => ui::info(&format!(
                "Deregistered; monitoring of {stopped} identities stopped."
            )),
            Deregistered::Unknown => ui::info(
                "The monitor no longer knows this provider's credential (already deregistered or replaced).",
            ),
        }
    }

    ui::step("Removing the provider");
    if let Some(compose) = &compose {
        compose.run(&["down", "--volumes", "--remove-orphans", "--rmi", "all"])?;
    }
    // This Docker daemon serves only the provider: clear whatever is left.
    let _ = crate::host::run(
        "docker",
        &["system", "prune", "--all", "--force", "--volumes"],
    );
    let _ = crate::host::run(
        "systemctl",
        &["--user", "disable", "--now", "hail-provider-backup.timer"],
    );
    if let Ok(home) = std::env::var("HOME") {
        let units = Path::new(&home).join(".config/systemd/user");
        for unit in ["hail-provider-backup.service", "hail-provider-backup.timer"] {
            let _ = fs::remove_file(units.join(unit));
        }
        let _ = crate::host::run("systemctl", &["--user", "daemon-reload"]);
    }
    for entry in fs::read_dir(&paths.dir)? {
        let path = entry?.path();
        if path.file_name().is_some_and(|name| name == ".hailctl.lock") {
            continue;
        }
        if path.is_dir() {
            fs::remove_dir_all(&path)?;
        } else {
            fs::remove_file(&path)?;
        }
    }
    fs::write(
        paths.dir.join(MARKER),
        format!(
            "{provider_id} decommissioned at {}\n",
            backup::stamp(crate::register::now())
        ),
    )?;
    ui::info("Containers, volumes, images, configuration and secrets are deleted.");

    ui::step("Done");
    ui::info("Finish on this server, as root: sudo hailctl-uninstall");
    ui::info("(removes the hail user, its rootless Docker and hailctl; keeps Docker Engine).");
    if let Some(answers) = &answers {
        ui::info("Then remove what lives elsewhere:");
        for item in external_cleanup(answers, &paths) {
            ui::info(&format!("  - {item}"));
        }
    }
    if let Some(kept) = kept {
        ui::info(&format!(
            "The final backup ({}) needs KEY_ENCRYPTION_KEY to restore.",
            kept.display()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::DEFAULT_MONITOR_API;

    /// A monitor that answers each request with the next canned status and body,
    /// recording what it was sent.
    fn monitor(
        replies: Vec<(u16, &'static str)>,
    ) -> (String, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{BufRead, BufReader, Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, body) in replies {
                let (stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream);
                let mut head = String::new();
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap();
                    }
                    if line == "\r\n" {
                        break;
                    }
                    head.push_str(&line);
                }
                let mut body_in = vec![0; length];
                reader.read_exact(&mut body_in).unwrap();
                requests.push(format!("{head}\n{}", String::from_utf8(body_in).unwrap()));
                write!(reader.get_mut(), "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
            requests
        });
        (origin, handle)
    }

    fn answers_at(monitor_api: String) -> Answers {
        Answers {
            api_host: "svr.example.org".into(),
            web_host: "example.org".into(),
            provider_id: "example".into(),
            operator_email: "ops@example.org".into(),
            monitor_api,
            secrets_to_file: false,
            ingress: Ingress::Direct,
            tunnel_token: None,
            email_bridge_domain: None,
        }
    }

    #[test]
    fn deregisters_with_the_monitor_credential_and_retries_while_the_receiver_catches_up() {
        let (origin, server) = monitor(vec![
            (
                503,
                r#"{"error":"Deregistered, but the receiver was not updated yet; retry"}"#,
            ),
            (200, r#"{"deregistered":true,"stoppedIdentities":2}"#),
        ]);
        let result = deregister(&answers_at(origin), "TOKEN").unwrap();
        assert_eq!(result, Deregistered::Done { stopped: 2 });
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].starts_with("POST /api/v1/providers/deregister "));
        assert!(
            requests[0]
                .to_ascii_lowercase()
                .contains("authorization: bearer token")
        );
        assert!(requests[0].ends_with(r#"{"providerOrigin":"https://svr.example.org"}"#));

        let (origin, server) = monitor(vec![(401, r#"{"error":"Unauthorized"}"#)]);
        assert_eq!(
            deregister(&answers_at(origin), "TOKEN").unwrap(),
            Deregistered::Unknown
        );
        server.join().unwrap();
        let (origin, server) = monitor(vec![(403, "")]);
        assert!(
            deregister(&answers_at(origin), "TOKEN")
                .unwrap_err()
                .to_string()
                .contains("403")
        );
        server.join().unwrap();
    }

    #[test]
    fn lists_what_only_the_operator_can_remove() {
        let dir = tempfile::tempdir().unwrap();
        let answers = Answers {
            api_host: "svr.example.org".into(),
            web_host: "example.org".into(),
            provider_id: "example".into(),
            operator_email: "ops@example.org".into(),
            monitor_api: DEFAULT_MONITOR_API.into(),
            secrets_to_file: false,
            ingress: Ingress::CloudflareTunnel,
            tunnel_token: None,
            email_bridge_domain: Some("example.email".into()),
        };
        let items = external_cleanup(&answers, &Paths::new(dir.path())).join("\n");
        assert!(items.contains("tunnel and its public hostnames svr.example.org and example.org"));
        assert!(items.contains("_hail-provider.example.org"));
        assert!(items.contains("example.email Email Routing"));
        assert!(items.contains("PLC identities"));
        assert!(!items.contains("A/AAAA"));
    }
}
