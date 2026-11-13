//! Off-host backup copies in an S3-compatible bucket (Cloudflare R2, Backblaze B2, AWS
//! S3, MinIO), using path-style requests signed with AWS Signature Version 4.
use anyhow::{Context, Result, anyhow, ensure};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Remote {
    /// `https://host[:port]`, with no path; buckets are addressed path-style.
    pub endpoint: String,
    pub bucket: String,
    /// `auto` for Cloudflare R2.
    #[serde(default = "default_region")]
    pub region: String,
    /// Prepended to each backup's file name, such as `hail/`.
    #[serde(default)]
    pub prefix: String,
    pub access_key_id: String,
    pub secret_access_key: String,
}

fn default_region() -> String {
    "auto".into()
}

impl Remote {
    pub fn check(&self) -> Result<()> {
        let host = self.host()?;
        ensure!(!host.is_empty(), "the endpoint has no host");
        ensure!(
            !self.bucket.is_empty()
                && self.bucket.len() <= 63
                && self.bucket.bytes().all(|b| b.is_ascii_lowercase()
                    || b.is_ascii_digit()
                    || b == b'-'
                    || b == b'.'),
            "the bucket name must be lowercase letters, digits, dots and hyphens"
        );
        ensure!(
            !self.region.is_empty()
                && self
                    .region
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-'),
            "invalid region"
        );
        ensure!(
            self.prefix
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._/-".contains(&b))
                && !self.prefix.starts_with('/')
                && !self.prefix.contains(".."),
            "the prefix may contain only letters, digits, '.', '_', '-' and '/'"
        );
        ensure!(
            !self.access_key_id.is_empty() && !self.secret_access_key.is_empty(),
            "the access key ID and secret access key are required"
        );
        Ok(())
    }

    /// Debug builds may use a plain-HTTP endpoint (a local MinIO) for testing.
    fn scheme(&self) -> &'static str {
        if cfg!(debug_assertions)
            && std::env::var_os("HAILCTL_DEV_SKIP_PUBLIC_CHECKS").is_some()
            && self.endpoint.starts_with("http://")
        {
            "http"
        } else {
            "https"
        }
    }

    fn host(&self) -> Result<&str> {
        let host = self
            .endpoint
            .strip_prefix(&format!("{}://", self.scheme()))
            .ok_or_else(|| anyhow!("the endpoint must start with https://"))?
            .trim_end_matches('/');
        ensure!(
            !host.contains('/') && !host.contains('?') && !host.contains('@'),
            "the endpoint must be https://host with no path"
        );
        Ok(host)
    }

    fn path(&self, name: &str) -> String {
        format!(
            "/{}/{}",
            self.bucket,
            encode(&format!("{}{name}", self.prefix))
        )
    }

    fn agent() -> ureq::Agent {
        // No overall timeout: backups can be large. Stalled transfers still fail.
        ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(30))
            .timeout_read(Duration::from_secs(300))
            .timeout_write(Duration::from_secs(300))
            .user_agent(concat!("hailctl/", env!("CARGO_PKG_VERSION")))
            .build()
    }

    fn request(&self, method: &str, name: &str, payload_hash: &str) -> Result<ureq::Request> {
        let host = self.host()?;
        let path = self.path(name);
        let now = crate::backup::utc(crate::register::now());
        let date = format!("{:04}{:02}{:02}", now.0, now.1, now.2);
        let stamp = format!("{date}T{:02}{:02}{:02}Z", now.3, now.4, now.5);
        let headers = [
            ("host", host.to_string()),
            ("x-amz-content-sha256", payload_hash.to_string()),
            ("x-amz-date", stamp.clone()),
        ];
        let authorization = authorization(
            &Credentials {
                access_key_id: &self.access_key_id,
                secret_access_key: &self.secret_access_key,
                region: &self.region,
            },
            method,
            &path,
            &headers,
            payload_hash,
            &stamp,
        );
        Ok(Self::agent()
            .request(method, &format!("{}://{host}{path}", self.scheme()))
            .set("x-amz-content-sha256", payload_hash)
            .set("x-amz-date", &stamp)
            .set("Authorization", &authorization))
    }

    /// Uploads a file, then downloads it again and compares the SHA-256.
    pub fn upload(&self, file: &Path, name: &str) -> Result<()> {
        let (hash, length) = hash_file(file)?;
        let request = self
            .request("PUT", name, &hash)?
            .set("Content-Length", &length.to_string())
            .set("Content-Type", "application/octet-stream");
        call(request.send(File::open(file)?), "upload to")?;
        let response = call(
            self.request("GET", name, EMPTY_SHA256)?.call(),
            "read back from",
        )?;
        let mut hasher = Sha256::new();
        std::io::copy(&mut response.into_reader(), &mut hasher)?;
        ensure!(
            hex(&hasher.finalize()) == hash,
            "the copy in the bucket does not match the local backup"
        );
        Ok(())
    }

    /// Proves the credentials can write, read and delete.
    pub fn test(&self) -> Result<()> {
        let name = ".hailctl-check";
        let body = b"hailctl";
        let hash = hex(&Sha256::digest(body));
        call(
            self.request("PUT", name, &hash)?
                .set("Content-Length", &body.len().to_string())
                .send_bytes(body),
            "write to",
        )?;
        let mut read = Vec::new();
        call(self.request("GET", name, EMPTY_SHA256)?.call(), "read from")?
            .into_reader()
            .take(64)
            .read_to_end(&mut read)?;
        ensure!(read == body, "the bucket returned different content");
        call(
            self.request("DELETE", name, EMPTY_SHA256)?.call(),
            "delete from",
        )?;
        Ok(())
    }
}

const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

fn call(result: Result<ureq::Response, ureq::Error>, action: &str) -> Result<ureq::Response> {
    match result {
        Ok(response) => Ok(response),
        Err(ureq::Error::Status(status, response)) => {
            let body = response.into_string().unwrap_or_default();
            let code = body
                .split("<Code>")
                .nth(1)
                .and_then(|rest| rest.split("</Code>").next())
                .unwrap_or("no details");
            Err(anyhow!("could not {action} the bucket ({status}: {code})"))
        }
        Err(error) => Err(anyhow!("could not {action} the bucket: {error}")),
    }
}

fn hash_file(path: &Path) -> Result<(String, u64)> {
    let mut file = File::open(path).with_context(|| format!("cannot read {}", path.display()))?;
    let mut hasher = Sha256::new();
    let length = std::io::copy(&mut file, &mut hasher)?;
    Ok((hex(&hasher.finalize()), length))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// URI-encodes an object key, keeping `/` (S3 does not double-encode keys).
fn encode(key: &str) -> String {
    key.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

struct Credentials<'a> {
    access_key_id: &'a str,
    secret_access_key: &'a str,
    region: &'a str,
}

/// The SigV4 `Authorization` header. `headers` are lowercase names, sorted by name, and
/// include `host`; the request has no query string.
fn authorization(
    credentials: &Credentials,
    method: &str,
    path: &str,
    headers: &[(&str, String)],
    payload_hash: &str,
    stamp: &str,
) -> String {
    let canonical_headers: String = headers
        .iter()
        .map(|(name, value)| format!("{name}:{}\n", value.trim()))
        .collect();
    let signed: Vec<&str> = headers.iter().map(|(name, _)| *name).collect();
    let signed = signed.join(";");
    let canonical = format!("{method}\n{path}\n\n{canonical_headers}\n{signed}\n{payload_hash}");
    let date = &stamp[..8];
    let scope = format!("{date}/{}/s3/aws4_request", credentials.region);
    let to_sign = format!(
        "AWS4-HMAC-SHA256\n{stamp}\n{scope}\n{}",
        hex(&Sha256::digest(canonical.as_bytes()))
    );
    let key = [credentials.region, "s3", "aws4_request"].iter().fold(
        hmac(
            format!("AWS4{}", credentials.secret_access_key).as_bytes(),
            date,
        ),
        |key, part| hmac(&key, part),
    );
    format!(
        "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed}, Signature={}",
        credentials.access_key_id,
        hex(&hmac(&key, &to_sign))
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const AWS: Credentials = Credentials {
        access_key_id: "AKIAIOSFODNN7EXAMPLE",
        secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        region: "us-east-1",
    };

    #[test]
    fn signs_the_aws_put_object_example() {
        // "Example: PUT Object" from the AWS Signature Version 4 documentation for S3.
        let hash = "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072";
        let headers = [
            ("date", "Fri, 24 May 2013 00:00:00 GMT".to_string()),
            ("host", "examplebucket.s3.amazonaws.com".to_string()),
            ("x-amz-content-sha256", hash.to_string()),
            ("x-amz-date", "20130524T000000Z".to_string()),
            ("x-amz-storage-class", "REDUCED_REDUNDANCY".to_string()),
        ];
        let header = authorization(
            &AWS,
            "PUT",
            &format!("/{}", encode("test$file.text")),
            &headers,
            hash,
            "20130524T000000Z",
        );
        assert!(header.ends_with(
            "SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd"
        ), "{header}");
        assert!(
            header.contains("Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request")
        );
    }

    #[test]
    fn validates_remote_settings() {
        let remote = Remote {
            endpoint: "https://abc.r2.cloudflarestorage.com".into(),
            bucket: "hail-backups".into(),
            region: "auto".into(),
            prefix: "provider/".into(),
            access_key_id: "id".into(),
            secret_access_key: "secret".into(),
        };
        remote.check().unwrap();
        assert_eq!(
            remote.path("example-20261112T000000Z-scheduled.tar.age"),
            "/hail-backups/provider/example-20261112T000000Z-scheduled.tar.age"
        );
        for broken in [
            Remote {
                endpoint: "http://abc".into(),
                ..remote.clone()
            },
            Remote {
                endpoint: "https://abc/path".into(),
                ..remote.clone()
            },
            Remote {
                bucket: "Upper".into(),
                ..remote.clone()
            },
            Remote {
                prefix: "../x".into(),
                ..remote.clone()
            },
            Remote {
                secret_access_key: String::new(),
                ..remote.clone()
            },
        ] {
            assert!(broken.check().is_err(), "{broken:?}");
        }
    }
}
