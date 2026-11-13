//! The inbound email bridge (spec/email-bridge.md): mail sent to aliases on a separate
//! domain reaches users as Hail messages from the provider's `email@` service account.
//! hailctl configures the provider side: settings, the converter and its database role,
//! and the sender account. Mail reaches the provider through an ingress adapter the
//! operator deploys (the reference one is a Cloudflare Email Worker).
use crate::compose::Compose;
use crate::state::{Answers, Env, secret};
use crate::ui;
use anyhow::{Result, anyhow, ensure};

const ROLE_SQL: &str = include_str!("../../server/deploy/email-bridge/converter-role.sql");
const LOGIN_SQL: &str = include_str!("../../server/deploy/email-bridge/converter-login.sql");
/// The reserved service account that sends bridged mail.
pub const SENDER: &str = "email";
/// Its Sender Profile: users grant this category to receive bridged mail.
const PROFILE: &str = r#"{"version":1,"display_name":"Email","description":"Mail received at your email aliases","categories":[{"id":"email","label":"Email","description":"Messages sent to your email aliases"}]}"#;
/// Set in .env once the converter's database role exists; starts the converter.
pub const READY: &str = "HAIL_EMAIL_BRIDGE";

pub fn enabled(env: &Env) -> bool {
    env.get("EMAIL_BRIDGE_DOMAIN").is_some()
}

/// The provider settings; secrets are generated once and never replaced.
pub fn configure(env: &mut Env, answers: &Answers) {
    let Some(domain) = &answers.email_bridge_domain else {
        return;
    };
    env.set("EMAIL_BRIDGE_DOMAIN", domain);
    env.set(
        "EMAIL_BRIDGE_SENDER",
        &format!("{SENDER}@{}", answers.web_host),
    );
    env.ensure("EMAIL_BRIDGE_INTAKE_TOKEN", secret);
    env.ensure("EMAIL_CONVERTER_DB_PASSWORD", secret);
}

/// The converter's limited database role and its login, as the database owner. Run after
/// the provider has migrated, again after a restore into a new database server, and after
/// upgrades (a release may change the role's grants). Idempotent.
pub fn database_roles(compose: &Compose, env: &Env) -> Result<()> {
    let password = env
        .get("EMAIL_CONVERTER_DB_PASSWORD")
        .filter(|p| {
            p.len() == 43
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
        .ok_or_else(|| anyhow!("EMAIL_CONVERTER_DB_PASSWORD is missing or malformed in .env"))?;
    let script = format!("{ROLE_SQL}\n\\set password '{password}'\n{LOGIN_SQL}");
    compose.input(
        &[
            "exec",
            "-T",
            "db",
            "psql",
            "-X",
            "-q",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            "hail",
            "-d",
            "hail",
        ],
        script.as_bytes(),
    )?;
    Ok(())
}

/// Creates (or resumes creating) `email@` and its Sender Profile.
pub fn sender(compose: &Compose, answers: &Answers, service_account: &str) -> Result<()> {
    let account = compose.provider_json(&[service_account, "create", SENDER])?;
    ensure!(
        account["active"] == serde_json::Value::Bool(true),
        "{SENDER}@{} was not activated; run hailctl install again",
        answers.web_host
    );
    let address = format!("{SENDER}@{}", answers.web_host);
    let profile = compose.input(
        &[
            "exec",
            "-T",
            "provider",
            "bun",
            "src/cli/create-profile.ts",
            &address,
            "/dev/stdin",
        ],
        PROFILE.as_bytes(),
    )?;
    let profile: serde_json::Value = serde_json::from_str(profile.trim())
        .map_err(|_| anyhow!("unexpected output while creating the Sender Profile"))?;
    ensure!(
        profile["categories"]
            .as_array()
            .is_some_and(|c| c.iter().any(|id| id == "email")),
        "the Sender Profile of {address} has no email category"
    );
    ui::info(&format!(
        "{address} is active with a Sender Profile offering the email category."
    ));
    Ok(())
}

/// What the operator still has to do: route the alias domain's mail to the provider.
pub fn adapter_instructions(answers: &Answers, env_path: &str) {
    let domain = answers.email_bridge_domain.as_deref().unwrap_or_default();
    ui::info("The provider now accepts mail for aliases, delivered by an ingress adapter. With");
    ui::info(&format!(
        "Cloudflare, put {domain} on Cloudflare, then from apps/server/deploy/cloudflare-email-worker:"
    ));
    ui::info("  create the R2 buckets and queue its README lists, then");
    ui::info("  bunx wrangler secret put INTAKE_TOKEN    # EMAIL_BRIDGE_INTAKE_TOKEN from .env");
    ui::info(&format!(
        "  bunx wrangler deploy --var PROVIDER_ORIGIN:{} --var ALIAS_DOMAIN:{domain}",
        answers.api_origin()
    ));
    ui::info(&format!(
        "and set the {domain} Email Routing catch-all to that Worker. The token is in {env_path}"
    ));
    ui::info("(sudo grep EMAIL_BRIDGE_INTAKE_TOKEN on it). Users then turn on Inbound email.");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_profile_offers_the_bridge_category() {
        let profile: serde_json::Value = serde_json::from_str(PROFILE).unwrap();
        assert_eq!(profile["categories"][0]["id"], "email");
        assert!(LOGIN_SQL.contains(":'password'"));
        assert!(ROLE_SQL.contains("hail_email_converter"));
    }
}
