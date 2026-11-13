//! Registration v2 with the shared monitor (spec/monitor-receiver.md): prove control of
//! both hostnames, confirm the operator email code, receive both credentials.
use crate::state::{Answers, Env, Registration, secret};
use anyhow::{Result, anyhow, bail};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

pub const DOCUMENT: &str = "hail-monitor-registration.json";
pub const PATH: &str = "/.well-known/hail-monitor-registration";

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// A registration that is still usable for at least ten minutes, or a fresh one.
pub fn current(existing: Option<Registration>) -> Registration {
    match existing {
        Some(registration) if registration.expires_at > now() + 600 => registration,
        _ => Registration {
            secret: secret(),
            expires_at: now() + 3600,
        },
    }
}

/// The public verification document; it contains only a hash of the secret.
pub fn document(answers: &Answers, registration: &Registration) -> Value {
    json!({
        "type": "hail.monitor-provider-registration",
        "version": 2,
        "monitorApiOrigin": answers.monitor_api,
        "providerOrigin": answers.api_origin(),
        "webOrigin": answers.web_origin(),
        "registrationHash": URL_SAFE_NO_PAD.encode(Sha256::digest(registration.secret.as_bytes())),
        "expiresAt": registration.expires_at,
    })
}

fn request_body(
    answers: &Answers,
    registration: &Registration,
    extra: Option<(&str, Value)>,
) -> Value {
    let mut body = json!({
        "providerOrigin": answers.api_origin(),
        "webOrigin": answers.web_origin(),
        "operatorEmail": answers.operator_email,
        "registrationSecret": registration.secret,
        "expiresAt": registration.expires_at,
    });
    if let Some((key, value)) = extra {
        body[key] = value;
    }
    body
}

fn post(answers: &Answers, body: &Value) -> Result<(u16, Value)> {
    let url = format!("{}/api/v1/providers/register", answers.monitor_api);
    let response = crate::release::agent()
        .post(&url)
        .set("Content-Type", "application/json")
        .send_string(&body.to_string());
    let (status, response) = match response {
        Ok(response) => (response.status(), response),
        Err(ureq::Error::Status(status, response)) => (status, response),
        Err(error) => return Err(anyhow!("could not reach the monitor: {error}")),
    };
    let value = response.into_json().unwrap_or(Value::Null);
    Ok((status, value))
}

fn refusal(value: &Value) -> String {
    value
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("no details")
        .to_string()
}

pub enum Requested {
    CodeSent {
        expires_at: u64,
    },
    /// A previous attempt already completed; the credentials are returned again.
    Registered(Value),
}

/// Asks the monitor to check the published documents and email the operator code.
pub fn request(answers: &Answers, registration: &Registration, resend: bool) -> Result<Requested> {
    let (status, value) = post(
        answers,
        &request_body(
            answers,
            registration,
            resend.then(|| ("resend", json!(true))),
        ),
    )?;
    match status {
        202 => Ok(Requested::CodeSent {
            expires_at: value.get("expiresAt").and_then(Value::as_u64).unwrap_or(0),
        }),
        200 => Ok(Requested::Registered(value)),
        _ => bail!(
            "the monitor refused the registration ({status}): {}",
            refusal(&value)
        ),
    }
}

pub enum Confirmed {
    Registered(Value),
    WrongCode,
}

pub fn confirm(answers: &Answers, registration: &Registration, code: &str) -> Result<Confirmed> {
    let (status, value) = post(
        answers,
        &request_body(answers, registration, Some(("operatorCode", json!(code)))),
    )?;
    match status {
        200 => Ok(Confirmed::Registered(value)),
        409 if refusal(&value) == "Incorrect code" => Ok(Confirmed::WrongCode),
        _ => bail!(
            "the monitor refused the code ({status}): {}",
            refusal(&value)
        ),
    }
}

/// Maps the registration result into the provider configuration.
pub fn apply(env: &mut Env, answers: &Answers, credentials: &Value) -> Result<()> {
    let field = |key: &str| {
        credentials
            .get(key)
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .ok_or_else(|| anyhow!("the monitor response has no {key}"))
    };
    if field("providerOrigin")? != answers.api_origin() {
        bail!("the monitor registered a different provider origin");
    }
    env.set("SIGNUP_EMAIL_ORIGIN", field("receiverOrigin")?);
    env.set("SIGNUP_EMAIL_TOKEN", field("receiverToken")?);
    env.set("SIGNUP_MONITOR_API_ORIGIN", field("apiOrigin")?);
    env.set("SIGNUP_MONITOR_TOKEN", field("token")?);
    env.set("SIGNUP_MONITOR_PUBLIC_KEY", field("monitorPublicKey")?);
    env.set("ALPHA_SIGNUP_MONITOR_ORIGIN", field("monitorOrigin")?);
    // Signs signup invitations; independent of every other secret.
    env.ensure("ALPHA_SIGNUP_INVITE_KEY", secret);
    env.set("PUBLIC_SELF_SERVICE_ONBOARDING", "true");
    env.set("PUBLIC_ALPHA_SIGNUP", "true");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::DEFAULT_MONITOR_API;

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
    fn matches_the_monitor_document_format() {
        // Same secret and expiry as spec/vectors/monitor-provider-registration.json.
        let registration = Registration {
            secret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into(),
            expires_at: 2_000_000_000,
        };
        let document = document(&answers(), &registration);
        assert_eq!(
            document["registrationHash"],
            "DwBzhbb51LfusnSGBa_hqYSgo7-j8BTQnip4TOnlzRo"
        );
        assert_eq!(document["providerOrigin"], "https://svr.example.org");
        assert_eq!(document["webOrigin"], "https://example.org");
        assert!(!document.to_string().contains(&registration.secret));
    }

    #[test]
    fn reuses_live_registrations_only() {
        let live = Registration {
            secret: "s".into(),
            expires_at: now() + 3000,
        };
        assert_eq!(current(Some(live.clone())), live);
        assert_ne!(
            current(Some(Registration {
                secret: "s".into(),
                expires_at: now() + 60
            }))
            .secret,
            "s"
        );
    }

    #[test]
    fn maps_credentials_and_enables_signup() {
        let mut env = Env::default();
        let credentials = json!({
            "providerOrigin": "https://svr.example.org", "receiverOrigin": "https://alerts.example.net", "receiverToken": "r",
            "apiOrigin": "https://enroll.example.net", "token": "t", "monitorPublicKey": "did:key:z6Mk", "monitorOrigin": "https://monitor.example.net",
        });
        apply(&mut env, &answers(), &credentials).unwrap();
        assert_eq!(env.get("SIGNUP_EMAIL_TOKEN"), Some("r"));
        assert_eq!(env.get("SIGNUP_MONITOR_TOKEN"), Some("t"));
        assert_eq!(env.get("PUBLIC_ALPHA_SIGNUP"), Some("true"));
        assert_eq!(env.get("ALPHA_SIGNUP_INVITE_KEY").map(str::len), Some(43));
        let mut other = credentials.clone();
        other["providerOrigin"] = json!("https://svr.other.org");
        assert!(apply(&mut Env::default(), &answers(), &other).is_err());
    }
}
