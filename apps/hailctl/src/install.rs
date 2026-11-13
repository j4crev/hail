//! `hailctl install` and the other operator commands. Every step records completion in
//! hailctl.json, so running `hailctl install` again resumes where it stopped.
use crate::compose::Compose;
use crate::state::{
    Answers, Env, Paths, State, base_env, load_answers, valid_email, valid_hostname,
    valid_provider_id,
};
use crate::{dns, host, register, release, ui};
use anyhow::{Context, Result, anyhow, bail, ensure};
use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub struct Options {
    pub dir: PathBuf,
    pub release: Option<String>,
    pub answers: Option<PathBuf>,
}

const SERVICE_ACCOUNT: &str = "src/cli/service-account.ts";

pub fn install(options: &Options) -> Result<()> {
    let paths = Paths::new(&options.dir);
    let mut state = State::load(&paths)?;

    ui::step("Checking this server");
    let preflight = host::preflight(!state.started)?;
    ui::info(&format!(
        "{} {} on {}",
        preflight.os.id,
        preflight.os.version,
        std::env::consts::ARCH
    ));
    for warning in &preflight.warnings {
        ui::info(&format!("Warning: {warning}"));
    }

    ui::step("Docker");
    if host::docker_ready() {
        ui::info("Docker Engine and Compose are installed.");
    } else {
        ensure!(
            ui::confirm(
                "Docker is not installed. Install it from Docker's official apt repository?",
                options.answers.is_some()
            )?,
            "Docker is required; install it and run hailctl install again"
        );
        host::install_docker(&preflight.os)?;
    }
    if state.answers.is_none() {
        let volumes = host::run(
            "docker",
            &["volume", "ls", "--quiet", "--filter", "name=hail-provider_"],
        )
        .unwrap_or_default();
        ensure!(
            volumes.trim().is_empty(),
            "this server already has hail-provider data volumes; hailctl will not reuse another installation's data"
        );
    }

    let answers = gather_answers(&state, options)?;
    if state.configured && state.answers.as_ref() != Some(&answers) {
        bail!(
            "these answers differ from the installed configuration; edit {} instead",
            paths.env().display()
        );
    }
    state.answers = Some(answers.clone());
    state.save(&paths)?;

    ui::step("Checking DNS");
    check_dns(&answers)?;

    if state.release.is_none() {
        ui::step("Downloading the provider release");
        let tag = match &options.release {
            Some(tag) => tag.clone(),
            None => release::latest_tag()?,
        };
        let fetched = release::fetch(&tag, &paths.release())?;
        ui::info(&format!(
            "{tag} (commit {}), signature verified.",
            &fetched.release.commit[..12]
        ));
        state.release = Some(tag);
        state.save(&paths)?;
    }

    if !state.configured {
        ui::step("Configuring");
        let mut env = Env::load(&paths.env())?;
        base_env(&mut env, &answers);
        env.save(&paths.env())?;
        let key = env
            .get("KEY_ENCRYPTION_KEY")
            .unwrap_or_default()
            .to_string();
        keep_secret(
            &paths,
            &answers,
            "KEY_ENCRYPTION_KEY",
            "Encrypts the keys this server holds. Without it, a database backup cannot be used.",
            &key,
        )?;
        state.configured = true;
        state.save(&paths)?;
    }

    let compose = Compose::new(&paths);
    ui::step("Starting the provider");
    compose.up()?;
    wait_ready(&answers)?;
    state.started = true;
    state.save(&paths)?;

    if !state.registered {
        ui::step("Registering with the shared monitor");
        register(&paths, &mut state, &answers)?;
        compose.run(&["up", "-d", "--wait"])?;
        wait_ready(&answers)?;
    }

    if !state.accounts {
        ui::step("Creating the administrator account");
        accounts(&paths, &answers, &compose)?;
        state.accounts = true;
        state.save(&paths)?;
    }

    let link = passkey_link(&compose)?;
    ui::step("Done");
    ui::info(&format!(
        "Your provider is running at {} (API {}).",
        answers.web_origin(),
        answers.api_origin()
    ));
    ui::info(&format!(
        "Open this link within ten minutes to create the admin@{} passkey:",
        answers.web_host
    ));
    println!("\n    {link}\n");
    ui::info("Then sign in and open /admin. Run `hailctl admin passkey-link` for a new link.");
    ui::info(&format!(
        "Back up {} (it holds the provider's secrets) and the server's database.",
        paths.env().display()
    ));
    Ok(())
}

fn gather_answers(state: &State, options: &Options) -> Result<Answers> {
    if let Some(path) = &options.answers {
        return load_answers(path);
    }
    if let Some(answers) = &state.answers {
        return Ok(answers.clone());
    }
    ensure!(
        ui::interactive(),
        "no terminal is attached; pass --answers FILE"
    );
    ui::step("About your provider");
    ui::info("You need two DNS names pointing at this server: one for the API, one for the");
    ui::info("web client. Addresses on this provider will be name@<web hostname>.");
    let api_host = ui::text(
        "API hostname:",
        "For example svr.example.com",
        valid_hostname,
        "Use a lowercase DNS name such as svr.example.com",
    )?;
    let web_host = ui::text(
        "Web hostname and address domain:",
        "For example example.com",
        valid_hostname,
        "Use a lowercase DNS name such as example.com",
    )?;
    let suggested: String = web_host
        .split('.')
        .next()
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    let provider_id = inquire::Text::new("Provider ID:")
        .with_default(&suggested)
        .with_help_message("A short lowercase name for this provider")
        .prompt()?;
    let operator_email = ui::text(
        "Operator email:",
        "Receives the registration code and operator notices",
        valid_email,
        "Enter a valid email address",
    )?;
    let answers = Answers {
        api_host,
        web_host,
        provider_id,
        operator_email,
        monitor_api: crate::state::DEFAULT_MONITOR_API.into(),
        secrets_to_file: false,
    };
    answers.check()?;
    ensure!(
        valid_provider_id(&answers.provider_id),
        "invalid provider ID"
    );
    Ok(answers)
}

fn check_dns(answers: &Answers) -> Result<()> {
    let public = dns::public_addresses();
    ensure!(
        !public.is_empty(),
        "could not determine this server's public address; check its internet access"
    );
    let delegation_name = format!("_hail-provider.{}", answers.web_host);
    let expected = dns::delegation(&answers.api_host);
    let deadline = Instant::now() + Duration::from_secs(30 * 60);
    loop {
        let mut problems = Vec::new();
        for host in [&answers.api_host, &answers.web_host] {
            let found = dns::addresses(host)?;
            if !found.iter().any(|address| public.contains(address)) {
                problems.push(format!("{host} resolves to [{}]", found.join(", ")));
            }
        }
        if !dns::txt(&delegation_name)?.contains(&expected) {
            problems.push(format!("{delegation_name} has no matching TXT record"));
        }
        if problems.is_empty() {
            ui::info("DNS points at this server.");
            return Ok(());
        }
        ui::info("Create these DNS records, then check again:");
        for host in [&answers.api_host, &answers.web_host] {
            for address in &public {
                let kind = if address.contains(':') { "AAAA" } else { "A" };
                ui::info(&format!("  {host:<40} {kind:<4} {address}"));
            }
        }
        ui::info(&format!("  {delegation_name:<40} TXT  \"{expected}\""));
        for problem in &problems {
            ui::info(&format!("Not yet: {problem}"));
        }
        if ui::interactive() {
            match ui::choose(
                "DNS is not ready.",
                vec!["Check again", "Continue anyway", "Stop"],
            )? {
                "Check again" => continue,
                "Continue anyway" => return Ok(()),
                _ => bail!("stopped; run hailctl install again once DNS is ready"),
            }
        }
        ensure!(
            Instant::now() < deadline,
            "DNS was not ready after 30 minutes"
        );
        std::thread::sleep(Duration::from_secs(30));
    }
}

fn wait_ready(answers: &Answers) -> Result<()> {
    ui::info("Waiting for HTTPS (certificates can take a minute)...");
    let deadline = Instant::now() + Duration::from_secs(10 * 60);
    let agent = release::agent();
    loop {
        let ready = [answers.api_origin(), answers.web_origin()]
            .iter()
            .all(|origin| {
                agent
                    .get(&format!("{origin}/health/ready"))
                    .call()
                    .is_ok_and(|r| r.status() == 200)
            });
        if ready {
            ui::info("Both hostnames are serving over HTTPS.");
            return Ok(());
        }
        ensure!(
            Instant::now() < deadline,
            "the provider did not become ready over HTTPS within ten minutes; check `hailctl status` and DNS"
        );
        std::thread::sleep(Duration::from_secs(10));
    }
}

/// Shows a secret that must be kept offline and waits for confirmation, or, for
/// unattended installs, appends it to a root-only file.
fn keep_secret(
    paths: &Paths,
    answers: &Answers,
    name: &str,
    purpose: &str,
    value: &str,
) -> Result<()> {
    // Written first, so a crash before confirmation cannot lose a secret shown only once.
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(paths.secrets())?;
    writeln!(file, "{name}={value}\n# {purpose}\n")?;
    file.sync_all()?;
    if answers.secrets_to_file || !ui::interactive() {
        ensure!(
            answers.secrets_to_file,
            "{name} must be backed up; run interactively or set secrets_to_file in the answers file"
        );
        ui::info(&format!(
            "{name} was written to {}. Copy it somewhere safe offline, then delete that file.",
            paths.secrets().display()
        ));
        return Ok(());
    }
    eprintln!("\n    {name}\n    {purpose}\n\n        {value}\n");
    while !ui::confirm("I have stored this somewhere safe and offline", false)? {
        eprintln!(
            "    It is also in {} until you confirm.",
            paths.secrets().display()
        );
    }
    if ui::confirm(
        &format!("Delete the copy in {}?", paths.secrets().display()),
        true,
    )? {
        fs::remove_file(paths.secrets())?;
    }
    Ok(())
}

fn register(paths: &Paths, state: &mut State, answers: &Answers) -> Result<()> {
    let registration = register::current(state.registration.clone());
    state.registration = Some(registration.clone());
    state.save(paths)?;
    fs::create_dir_all(paths.registration())?;
    let document = register::document(answers, &registration);
    fs::write(
        paths.registration().join(register::DOCUMENT),
        serde_json::to_vec(&document)?,
    )?;
    // Caddy serves the document on both hostnames; confirm before asking the monitor.
    let agent = release::agent();
    for origin in [answers.api_origin(), answers.web_origin()] {
        let served: serde_json::Value = agent
            .get(&format!("{origin}{}", register::PATH))
            .call()
            .with_context(|| format!("{origin}{} is not reachable", register::PATH))?
            .into_json()?;
        ensure!(
            served == document,
            "{origin}{} does not serve the expected document",
            register::PATH
        );
    }
    let mut resend = false;
    let credentials = loop {
        match register::request(answers, &registration, resend)? {
            register::Requested::Registered(credentials) => break credentials,
            register::Requested::CodeSent { expires_at } => ui::info(&format!(
                "The monitor emailed a code to {}; it is valid for {} more minutes.",
                answers.operator_email,
                expires_at.saturating_sub(register::now()) / 60
            )),
        }
        let confirmed = loop {
            let code = ui::operator_code(&answers.operator_email)?;
            if code == "resend" {
                break None;
            }
            match register::confirm(answers, &registration, &code)? {
                register::Confirmed::Registered(credentials) => break Some(credentials),
                register::Confirmed::WrongCode => ui::info("That code is not correct; try again."),
            }
        };
        match confirmed {
            Some(credentials) => break credentials,
            None => resend = true,
        }
    };
    let mut env = Env::load(&paths.env())?;
    register::apply(&mut env, answers, &credentials)?;
    env.save(&paths.env())?;
    let _ = fs::remove_file(paths.registration().join(register::DOCUMENT));
    state.registered = true;
    state.registration = None;
    state.save(paths)?;
    ui::info("Registered; signup email and identity monitoring are configured.");
    Ok(())
}

fn accounts(paths: &Paths, answers: &Answers, compose: &Compose) -> Result<()> {
    let recovery = compose.provider_json(&[SERVICE_ACCOUNT, "recovery-key", "show"])?;
    if recovery["publicKey"].is_null() {
        let generated = compose.provider_json(&[SERVICE_ACCOUNT, "recovery-key", "generate"])?;
        let private = generated["privateKeyHex"]
            .as_str()
            .ok_or_else(|| anyhow!("no recovery key was returned"))?;
        keep_secret(
            paths,
            answers,
            "PROVIDER_RECOVERY_PRIVATE_KEY",
            "Recovers this provider's service accounts (admin@ and others) if the server is lost. Shown only once.",
            private,
        )?;
    }
    let admin = compose.provider_json(&[SERVICE_ACCOUNT, "create", "admin"])?;
    ensure!(
        admin["active"] == serde_json::Value::Bool(true),
        "admin@{} was not activated; run hailctl install again",
        answers.web_host
    );
    ui::info(&format!("admin@{} is active.", answers.web_host));
    Ok(())
}

fn passkey_link(compose: &Compose) -> Result<String> {
    let link = compose.provider_json(&[SERVICE_ACCOUNT, "passkey-link", "admin"])?;
    link["url"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| anyhow!("no passkey link was returned"))
}

fn configured(dir: &Path) -> Result<(Paths, State)> {
    let paths = Paths::new(dir);
    let state = State::load(&paths)?;
    ensure!(
        state.configured && state.release.is_some(),
        "no provider is installed in {}; run hailctl install",
        dir.display()
    );
    ensure!(
        host::is_root(),
        "run hailctl as root (for example with sudo)"
    );
    Ok((paths, state))
}

pub fn upgrade(dir: &Path, tag: Option<String>) -> Result<()> {
    let (paths, mut state) = configured(dir)?;
    let answers = state
        .answers
        .clone()
        .ok_or_else(|| anyhow!("hailctl.json has no answers"))?;
    let current = state.release.clone().unwrap_or_default();
    let tag = match tag {
        Some(tag) => tag,
        None => release::latest_tag()?,
    };
    let version = |tag: &str| tag.strip_prefix("provider-v").unwrap_or(tag).to_string();
    release::check_upgrade(&version(&current), &version(&tag))?;
    ui::step(&format!("Upgrading {current} to {tag}"));
    let rollback = paths.dir.join("release-rollback");
    if rollback.exists() {
        fs::remove_dir_all(&rollback)?;
    }
    fs::rename(paths.release(), &rollback)?;
    let result = release::fetch(&tag, &paths.release()).and_then(|fetched| {
        ui::info(&format!(
            "{tag} (commit {}), signature verified.",
            &fetched.release.commit[..12]
        ));
        let compose = Compose::new(&paths);
        compose.up()?;
        wait_ready(&answers)
    });
    match result {
        Ok(()) => {
            fs::remove_dir_all(&rollback)?;
            state.release = Some(tag.clone());
            state.save(&paths)?;
            ui::info(&format!("Upgraded to {tag}."));
            Ok(())
        }
        Err(error) => {
            ui::info(&format!(
                "Upgrade failed: {error:#}. Restoring {current}..."
            ));
            if paths.release().exists() {
                fs::remove_dir_all(paths.release())?;
            }
            fs::rename(&rollback, paths.release())?;
            Compose::new(&paths).run(&["up", "-d", "--wait"])?;
            bail!(
                "upgrade to {tag} failed and {current} was restored (database migrations are not rolled back)"
            )
        }
    }
}

pub fn status(dir: &Path) -> Result<()> {
    let (paths, state) = configured(dir)?;
    let answers = state
        .answers
        .clone()
        .ok_or_else(|| anyhow!("hailctl.json has no answers"))?;
    println!("Release: {}", state.release.as_deref().unwrap_or("none"));
    println!(
        "Registered with the shared monitor: {}",
        if state.registered { "yes" } else { "no" }
    );
    Compose::new(&paths).run(&["ps"])?;
    for origin in [answers.api_origin(), answers.web_origin()] {
        let ready = release::agent()
            .get(&format!("{origin}/health/ready"))
            .call()
            .is_ok_and(|r| r.status() == 200);
        println!(
            "{origin}/health/ready: {}",
            if ready { "ok" } else { "NOT READY" }
        );
    }
    Ok(())
}

pub fn admin_link(dir: &Path) -> Result<()> {
    let (paths, _) = configured(dir)?;
    println!("{}", passkey_link(&Compose::new(&paths))?);
    Ok(())
}

pub fn service_account(dir: &Path, name: &str) -> Result<()> {
    let (paths, _) = configured(dir)?;
    let created = Compose::new(&paths).provider_json(&[SERVICE_ACCOUNT, "create", name])?;
    println!("{}", serde_json::to_string_pretty(&created)?);
    Ok(())
}
