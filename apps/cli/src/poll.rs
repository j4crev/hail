use crate::{
    api::Client,
    contract::{DID, Error, ID},
    jmap,
};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::time::{Instant, sleep, timeout_at};

fn retry_delay(error: &Error, interval: u64) -> Option<Duration> {
    matches!(error.status, Some(429 | 503))
        .then(|| Duration::from_secs(interval.max(error.retry_after.unwrap_or(interval))))
}

fn validate_status(result: &Value, id: &str) -> Result<(), Error> {
    let revision = result["revision"].as_f64();
    if result["messageId"] != id
        || !result["state"].as_str().is_some_and(|s| {
            [
                "indeterminate",
                "accepted",
                "on-hold",
                "delivered",
                "failed",
                "cancelled",
            ]
            .contains(&s)
        })
        || if result["state"] == "indeterminate" {
            result.get("revision") != Some(&Value::Null)
        } else {
            !revision
                .is_some_and(|n| (1.0..=9_007_199_254_740_991.0).contains(&n) && n.fract() == 0.0)
        }
    {
        return Err(Error::response("Provider returned invalid message status"));
    }
    Ok(())
}

pub async fn status(
    client: &Client,
    id: &str,
    seconds: Option<u64>,
    interval: u64,
) -> Result<Value, Error> {
    if !ID.is_match(id) {
        return Err(Error::usage("Invalid message ID or wait bounds"));
    }
    let args = json!({"kind":"message","id":id});
    let Some(seconds) = seconds else {
        let result = client.jmap("HailSubmission/status", &args).await?;
        validate_status(&result, id)?;
        return Ok(result);
    };
    let deadline = Instant::now() + Duration::from_secs(seconds);
    let mut last = None;
    let mut failure = None;
    while Instant::now() < deadline {
        let mut delay = Duration::from_secs(interval);
        match timeout_at(deadline, client.jmap("HailSubmission/status", &args)).await {
            Err(_) => {
                failure = Some(Error::transport());
                break;
            }
            Ok(Ok(mut result)) => {
                validate_status(&result, id)?;
                if matches!(
                    result["state"].as_str(),
                    Some("delivered" | "failed" | "cancelled")
                ) {
                    result["wait"] = json!({"completed":true,"timedOut":false});
                    return Ok(result);
                }
                last = Some(result);
            }
            Ok(Err(error)) => {
                delay = match retry_delay(&error, interval) {
                    Some(delay) => delay,
                    None => return Err(error),
                };
                failure = Some(error);
            }
        }
        if timeout_at(deadline, sleep(delay)).await.is_err() {
            break;
        }
    }
    if let Some(mut result) = last {
        result["wait"] = json!({"completed":false,"timedOut":true});
        Ok(result)
    } else {
        Err(failure.take().unwrap_or_else(|| {
            Error::new(
                "TRANSPORT_ERROR",
                "Status wait deadline elapsed before any status was observed",
            )
        }))
    }
}

#[cfg(unix)]
pub async fn inbox(
    client: &Client,
    from: Option<&str>,
    after: Option<&str>,
    seconds: u64,
    interval: u64,
) -> Result<Value, Error> {
    use tokio::signal::unix::{SignalKind, signal};
    if from.is_some_and(|s| !DID.is_match(s)) || after.is_some_and(|s| !jmap::valid_state(s)) {
        return Err(Error::usage("Invalid inbox wait selection or bounds"));
    }
    let mut sigint = signal(SignalKind::interrupt())
        .map_err(|_| Error::client("Cannot install inbox interrupt handler"))?;
    let mut sigterm = signal(SignalKind::terminate())
        .map_err(|_| Error::client("Cannot install inbox interrupt handler"))?;
    let deadline = Instant::now() + Duration::from_secs(seconds);
    let mut continuation = after.map(str::to_owned);
    let mut interrupted = false;
    let polling = async {
        let mut account = None;
        loop {
            let mut delay = Duration::from_secs(interval);
            let next = async {
                if account.is_none() {
                    account = Some(jmap::message_account(client).await?);
                }
                let account = account.as_deref().unwrap();
                if continuation.is_none() {
                    continuation = Some(jmap::inbox_baseline(client, account).await?);
                }
                jmap::inbox_changes(client, account, continuation.as_deref().unwrap(), from).await
            }
            .await;
            match next {
                Ok(mut result) => {
                    continuation = result["cursor"].as_str().map(str::to_owned);
                    if !result["messages"].as_array().unwrap().is_empty() {
                        result["wait"] =
                            json!({"completed":true,"timedOut":false,"interrupted":false});
                        return Ok(result);
                    }
                    // A page can contain only updates, deletions or other senders.
                    // Drain it immediately; delaying here can starve later creations.
                    if result["hasMore"] == true {
                        continue;
                    }
                }
                Err(error) => {
                    delay = match retry_delay(&error, interval) {
                        Some(d) => d,
                        None => return Err(error),
                    };
                }
            }
            sleep(delay).await;
        }
    };
    // Dropping the losing future cancels both response streaming and retry sleeps.
    tokio::select! {
        biased;
        _ = sigint.recv() => { interrupted = true; }
        _ = sigterm.recv() => { interrupted = true; }
        _ = tokio::time::sleep_until(deadline) => {}
        result = polling => return result,
    }
    Ok(
        json!({"messages":[],"cursor":continuation,"hasMore":false,"contentTrust":"untrusted",
        "wait":{"completed":false,"timedOut":Instant::now() >= deadline,"interrupted":interrupted}}),
    )
}

#[cfg(not(unix))]
pub async fn inbox(
    _: &Client,
    _: Option<&str>,
    _: Option<&str>,
    _: u64,
    _: u64,
) -> Result<Value, Error> {
    Err(Error::client(
        "Inbox interruption is currently supported only on Unix",
    ))
}
