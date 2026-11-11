use crate::{
    api::Client,
    contract::{DID, Error, ID},
};
use serde_json::{Value, json};
const CORE: &str = "urn:ietf:params:jmap:core";
const ACCOUNT: &str = "https://haili.app/ns/jmap/account";
const MESSAGES: &str = "https://haili.app/ns/jmap/messages";

pub(crate) async fn call(client: &Client, method: &str, args: Value) -> Result<Value, Error> {
    // Use the credential's fixed origin, never a Session-supplied URL.
    let result = client
        .request_at(
            "/jmap",
            "",
            Some(&json!({
                "using":[CORE,if method.starts_with("HailMessage/") { MESSAGES } else { ACCOUNT }],"methodCalls":[[method,args,"call"]]
            })),
        )
        .await?;
    let responses = result["methodResponses"]
        .as_array()
        .ok_or_else(|| Error::response("Invalid JMAP response"))?;
    if responses.len() != 1 || responses[0][2] != "call" {
        return Err(Error::response("Invalid JMAP response"));
    }
    let response = &responses[0];
    if response[0] == "error" {
        let kind = response[1]["type"].as_str().unwrap_or("unknown");
        if kind == "accountNotFound"
            || method == "HailMessage/changes" && kind == "cannotCalculateChanges"
        {
            return Err(Error::new(
                "JMAP_RESYNC_REQUIRED",
                "Mailbox state expired or the provider/account changed; fetch a fresh mailbox snapshot before resuming inbox wait",
            ));
        }
        let status = response[1]["httpStatus"]
            .as_u64()
            .and_then(|n| u16::try_from(n).ok())
            .filter(|n| (400..600).contains(n))
            .or(match kind {
                "serverFail" | "serverUnavailable" => Some(503),
                "rateLimit" => Some(429),
                "forbidden" => Some(403),
                "notFound" => Some(404),
                "stateMismatch" => Some(409),
                "invalidArguments" => Some(400),
                _ => None,
            });
        let code = match (status, response[1]["code"].as_str()) {
            (Some(401), Some(code @ ("CREDENTIAL_EXPIRED" | "CREDENTIAL_REVOKED")))
            | (
                Some(403),
                Some(code @ ("MISSING_SCOPE" | "PASSKEY_REQUIRED" | "INTERACTION_REQUIRED")),
            )
            | (Some(410), Some(code @ "APPROVAL_EXPIRED")) => code,
            _ => "JMAP_ERROR",
        };
        let mut error = Error::new(
            code,
            format!("JMAP {method}: {kind}; retain the original request when retrying"),
        );
        error.status = status;
        return Err(error);
    }
    if response[0] != method || !response[1].is_object() {
        return Err(Error::response("Invalid JMAP method response"));
    }
    Ok(response[1].clone())
}

pub async fn delete(client: &Client, sender: &str, message: &str) -> Result<Value, Error> {
    if !DID.is_match(sender) || !ID.is_match(message) {
        return Err(Error::usage("Invalid sender DID or message ID"));
    }
    let session = client.request_at("/.well-known/jmap", "", None).await?;
    let account = session["primaryAccounts"][MESSAGES]
        .as_str()
        .ok_or_else(|| {
            Error::client("Provider does not offer Hail JMAP messages for this credential")
        })?;
    if session["accounts"][account]["accountCapabilities"][MESSAGES]["canDestroy"] != true {
        return Err(Error::client(
            "Permanent deletion requires an unfenced credential with messages:read and messages:write",
        ));
    }
    let query = call(
        client,
        "HailMessage/query",
        json!({"accountId":account,"filter":{"sender":sender,"messageId":message},"limit":2}),
    )
    .await?;
    let ids = query["ids"]
        .as_array()
        .ok_or_else(|| Error::response("Invalid JMAP query"))?;
    let state = query["queryState"]
        .as_str()
        .ok_or_else(|| Error::response("Missing JMAP query state"))?;
    if query["accountId"] != account
        || ids.len() > 1
        || ids.iter().any(|id| {
            !id.as_str()
                .is_some_and(|s| s.starts_with("m_") && s.len() <= 255)
        })
    {
        return Err(Error::response("Invalid JMAP message selection"));
    }
    if let Some(id) = ids.first() {
        let result = call(
            client,
            "HailMessage/set",
            json!({"accountId":account,"ifInState":state,"destroy":[id]}),
        )
        .await?;
        if result["accountId"] != account || result["destroyed"] != json!([id]) {
            let reason = result["notDestroyed"][id.as_str().unwrap()]["type"]
                .as_str()
                .unwrap_or("invalidResponse");
            return Err(Error::new(
                "JMAP_ERROR",
                format!("Message deletion failed: {reason}"),
            ));
        }
    }
    Ok(json!({"messageId":message,"state":"deleted"}))
}

pub(crate) fn valid_state(state: &str) -> bool {
    !state.is_empty() && state.len() <= 1024 && !state.chars().any(char::is_control)
}

pub(crate) async fn message_account(client: &Client) -> Result<String, Error> {
    let session = client.request_at("/.well-known/jmap", "", None).await?;
    let account = session["primaryAccounts"][MESSAGES]
        .as_str()
        .ok_or_else(|| {
            Error::client("Provider does not offer Hail JMAP messages for this credential")
        })?;
    if account.is_empty()
        || account.len() > 255
        || !session["accounts"][account]["accountCapabilities"][MESSAGES].is_object()
    {
        return Err(Error::response("Invalid JMAP account discovery"));
    }
    Ok(account.to_owned())
}

pub(crate) async fn inbox_baseline(client: &Client, account: &str) -> Result<String, Error> {
    let result = call(
        client,
        "HailMessage/get",
        json!({"accountId":account,"ids":[]}),
    )
    .await?;
    let state = result["state"]
        .as_str()
        .filter(|s| valid_state(s))
        .ok_or_else(|| Error::response("Invalid JMAP baseline state"))?;
    if result["accountId"] != account
        || result["list"] != json!([])
        || result["notFound"] != json!([])
    {
        return Err(Error::response("Invalid JMAP baseline"));
    }
    Ok(state.to_owned())
}

pub(crate) async fn inbox_changes(
    client: &Client,
    account: &str,
    since: &str,
    from: Option<&str>,
) -> Result<Value, Error> {
    use std::collections::HashSet;
    let delta = call(
        client,
        "HailMessage/changes",
        json!({"accountId":account,"sinceState":since,"maxChanges":50}),
    )
    .await?;
    let state = delta["newState"]
        .as_str()
        .filter(|s| valid_state(s))
        .ok_or_else(|| Error::response("Invalid JMAP change state"))?;
    let more = delta["hasMoreChanges"]
        .as_bool()
        .ok_or_else(|| Error::response("Invalid JMAP change page"))?;
    if delta["accountId"] != account || delta["oldState"] != since || more && state == since {
        return Err(Error::response("Invalid JMAP change page"));
    }
    let mut all = HashSet::new();
    for field in ["created", "updated", "destroyed"] {
        let ids = delta[field]
            .as_array()
            .ok_or_else(|| Error::response("Invalid JMAP changes"))?;
        for id in ids {
            let id = id
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 255)
                .ok_or_else(|| Error::response("Invalid JMAP change ID"))?;
            if !all.insert(id) {
                return Err(Error::response("Duplicate JMAP change ID"));
            }
        }
    }
    if all.len() > 50 {
        return Err(Error::response("JMAP change page exceeded its limit"));
    }
    if state == since && !all.is_empty() {
        return Err(Error::response("JMAP changes did not advance their state"));
    }
    let created = delta["created"].as_array().unwrap();
    let mut messages = Vec::new();
    if !created.is_empty() {
        let result = call(
            client,
            "HailMessage/get",
            json!({"accountId":account,"ids":created,
            "properties":["id","sender","messageId","deliveredAt"]}),
        )
        .await?;
        let rows = result["list"]
            .as_array()
            .ok_or_else(|| Error::response("Invalid JMAP message page"))?;
        let missing = result["notFound"]
            .as_array()
            .ok_or_else(|| Error::response("Invalid JMAP message page"))?;
        if result["accountId"] != account || rows.len() + missing.len() != created.len() {
            return Err(Error::response("Incomplete JMAP message page"));
        }
        let mut seen = HashSet::new();
        for row in rows {
            let id = row["id"]
                .as_str()
                .ok_or_else(|| Error::response("Invalid JMAP message ID"))?;
            if !created.iter().any(|value| value == id)
                || !seen.insert(id)
                || !row["messageId"].as_str().is_some_and(|s| ID.is_match(s))
                || !row["sender"].as_str().is_some_and(|s| DID.is_match(s))
                || !row["deliveredAt"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty() && s.len() <= 64)
            {
                return Err(Error::response("Invalid JMAP received message"));
            }
            if from.is_none_or(|sender| row["sender"] == sender) {
                messages.push(row.clone());
            }
        }
        for id in missing {
            let id = id
                .as_str()
                .ok_or_else(|| Error::response("Invalid JMAP missing ID"))?;
            if !created.iter().any(|value| value == id) || !seen.insert(id) {
                return Err(Error::response("Invalid JMAP missing ID"));
            }
        }
    }
    // Advance only through the changes page, not the later get's state: new
    // arrivals between changes and get must remain visible to the next poll.
    Ok(json!({"messages":messages,"cursor":state,"hasMore":more,"contentTrust":"untrusted"}))
}

pub(crate) async fn operation(client: &Client, method: &str, args: &Value) -> Result<Value, Error> {
    let session = client.request_at("/.well-known/jmap", "", None).await?;
    let account = session["primaryAccounts"][ACCOUNT]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 255)
        .ok_or_else(|| Error::response("Missing JMAP account capability"))?;
    if !session["accounts"][account]["accountCapabilities"][ACCOUNT].is_object() {
        return Err(Error::response("Invalid JMAP account discovery"));
    }
    let mut args = args
        .as_object()
        .cloned()
        .ok_or_else(|| Error::client("Invalid JMAP arguments"))?;
    args.insert("accountId".into(), account.into());
    let result = call(client, method, Value::Object(args)).await?;
    if result["accountId"] != account {
        return Err(Error::response("JMAP account mismatch"));
    }
    Ok(result)
}
