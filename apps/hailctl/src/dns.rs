//! DNS checks through public DNS-over-HTTPS, so results match what the internet sees
//! rather than this host's resolver cache.
use anyhow::{Context, Result};
use serde::Deserialize;

const DOH: &str = "https://cloudflare-dns.com/dns-query";

#[derive(Deserialize)]
struct Response {
    #[serde(rename = "Answer", default)]
    answer: Vec<Answer>,
}
#[derive(Deserialize)]
struct Answer {
    #[serde(rename = "type")]
    kind: u16,
    data: String,
}

fn query(name: &str, kind: &str) -> Result<Vec<(u16, String)>> {
    let response: Response = crate::release::agent()
        .get(DOH)
        .query("name", name)
        .query("type", kind)
        .set("Accept", "application/dns-json")
        .call()
        .with_context(|| format!("DNS lookup for {name} failed"))?
        .into_json()?;
    Ok(response
        .answer
        .into_iter()
        .map(|a| (a.kind, a.data))
        .collect())
}

/// A and AAAA addresses of a hostname, following CNAMEs.
pub fn addresses(name: &str) -> Result<Vec<String>> {
    let mut found = Vec::new();
    for kind in ["A", "AAAA"] {
        found.extend(
            query(name, kind)?
                .into_iter()
                .filter(|(t, _)| *t == 1 || *t == 28)
                .map(|(_, data)| data),
        );
    }
    Ok(found)
}

/// TXT records, with DNS quoting and string splits removed.
pub fn txt(name: &str) -> Result<Vec<String>> {
    Ok(query(name, "TXT")?
        .into_iter()
        .filter(|(t, _)| *t == 16)
        .map(|(_, data)| unquote_txt(&data))
        .collect())
}

pub fn unquote_txt(data: &str) -> String {
    let mut out = String::new();
    let mut inside = false;
    let mut chars = data.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => inside = !inside,
            '\\' if inside => out.extend(chars.next()),
            c if inside => out.push(c),
            _ => {}
        }
    }
    if out.is_empty() {
        data.to_string()
    } else {
        out
    }
}

/// This host's public IPv4 and IPv6 addresses as seen from the internet (either may
/// be missing). curl is used because it can select the address family.
pub fn public_addresses() -> Vec<String> {
    ["-4", "-6"]
        .into_iter()
        .filter_map(|family| {
            let output = std::process::Command::new("curl")
                .args([
                    family,
                    "--silent",
                    "--max-time",
                    "10",
                    "--proto",
                    "=https",
                    "https://cloudflare.com/cdn-cgi/trace",
                ])
                .output()
                .ok()?;
            let text = String::from_utf8_lossy(&output.stdout).into_owned();
            text.lines()
                .find_map(|line| line.strip_prefix("ip="))
                .map(str::to_string)
        })
        .collect()
}

/// The `_hail-provider` record value that delegates an address domain to the API host.
pub fn delegation(api_host: &str) -> String {
    format!("v=hail1; provider={api_host}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unquotes_split_txt_strings() {
        assert_eq!(
            unquote_txt("\"v=hail1; \" \"provider=svr.example.com\""),
            "v=hail1; provider=svr.example.com"
        );
        assert_eq!(
            unquote_txt("\"a \\\"quoted\\\" value\""),
            "a \"quoted\" value"
        );
        assert_eq!(
            delegation("svr.example.com"),
            "v=hail1; provider=svr.example.com"
        );
    }
}
