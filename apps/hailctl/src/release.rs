//! Provider releases: discovery, download and verification against the pinned key
//! (agents/release-process.md#provider-releases).
use anyhow::{Context, Result, anyhow, bail, ensure};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::Path;

/// The release signing public key, pinned at build time.
pub const SIGNING_DID: &str =
    include_str!("../../server/deploy/release/provider-release-signing.did");
pub const SIGNATURE_CONTEXT: &[u8] = b"hail.provider-release.v2\0";
pub const RELEASES: &str = "https://github.com/j4crev/hail/releases/download";
const API: &str = "https://api.github.com/repos/j4crev/hail/releases?per_page=100";
pub const PLATFORMS: [&str; 2] = ["linux/amd64", "linux/arm64"];

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Image {
    pub repository: String,
    pub digest: String,
    pub platforms: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Images {
    pub provider: Image,
    pub web_client: Image,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Bundle {
    pub name: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Tools {
    pub hailctl: BTreeMap<String, String>,
}

/// `hail.provider-release` version 2.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Release {
    #[serde(rename = "type")]
    pub kind: String,
    pub version: u32,
    pub release: String,
    pub tag: String,
    pub commit: String,
    pub images: Images,
    pub tools: Tools,
    pub bundle: Bundle,
    pub created_at: String,
}

fn hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(hex64)
}

/// A dotted MAJOR.MINOR.PATCH version without leading zeros.
pub fn parse_version(version: &str) -> Option<(u64, u64, u64)> {
    let parts: Vec<&str> = version.split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|p| p.is_empty() || (p.len() > 1 && p.starts_with('0')))
    {
        return None;
    }
    let numbers: Vec<u64> = parts
        .iter()
        .map(|p| p.parse().ok())
        .collect::<Option<_>>()?;
    Some((numbers[0], numbers[1], numbers[2]))
}

pub fn version_of_tag(tag: &str) -> Option<(u64, u64, u64)> {
    parse_version(tag.strip_prefix("provider-v")?)
}

impl Release {
    fn check(&self) -> Result<()> {
        let image_ok = |image: &Image| {
            image.repository.starts_with("ghcr.io/")
                && digest(&image.digest)
                && image.platforms.len() == PLATFORMS.len()
                && PLATFORMS
                    .iter()
                    .all(|p| image.platforms.get(*p).is_some_and(|d| digest(d)))
        };
        ensure!(
            self.kind == "hail.provider-release"
                && self.version == 2
                && parse_version(&self.release).is_some()
                && self.tag == format!("provider-v{}", self.release)
                && self.commit.len() == 40
                && self.commit.bytes().all(|b| b.is_ascii_hexdigit())
                && image_ok(&self.images.provider)
                && image_ok(&self.images.web_client)
                && self.tools.hailctl.len() == PLATFORMS.len()
                && PLATFORMS
                    .iter()
                    .all(|p| self.tools.hailctl.get(*p).is_some_and(|h| hex64(h)))
                && self.bundle.name == format!("hail-provider-{}.tar.gz", self.release)
                && hex64(&self.bundle.sha256),
            "the release manifest is malformed"
        );
        Ok(())
    }
}

fn verifying_key(did: &str) -> Result<VerifyingKey> {
    let encoded = did
        .trim()
        .strip_prefix("did:key:z")
        .ok_or_else(|| anyhow!("expected a did:key"))?;
    let bytes = bs58::decode(encoded)
        .into_vec()
        .context("malformed did:key")?;
    ensure!(
        bytes.len() == 34 && bytes[0] == 0xed && bytes[1] == 0x01,
        "expected an Ed25519 did:key"
    );
    VerifyingKey::from_bytes(bytes[2..].try_into()?).context("invalid Ed25519 public key")
}

/// Verifies the detached signature over the exact manifest bytes, then parses them.
pub fn verify_manifest(bytes: &[u8], signature: &str, did: &str) -> Result<Release> {
    let raw = URL_SAFE_NO_PAD
        .decode(signature.trim())
        .context("malformed release signature")?;
    let signature = Signature::from_slice(&raw).context("malformed release signature")?;
    let mut signed = SIGNATURE_CONTEXT.to_vec();
    signed.extend_from_slice(bytes);
    verifying_key(did)?
        .verify(&signed, &signature)
        .map_err(|_| anyhow!("the release signature does not verify against the pinned key"))?;
    let release: Release =
        serde_json::from_slice(bytes).context("the release manifest is not valid JSON")?;
    release.check()?;
    Ok(release)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(60))
        .user_agent(concat!("hailctl/", env!("CARGO_PKG_VERSION")))
        .redirects(5)
        .build()
}

fn download(url: &str, limit: u64) -> Result<Vec<u8>> {
    let response = agent()
        .get(url)
        .call()
        .with_context(|| format!("could not download {url}"))?;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(limit + 1)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= limit, "{url} is larger than expected");
    Ok(bytes)
}

/// The newest published provider release tag.
pub fn latest_tag() -> Result<String> {
    #[derive(Deserialize)]
    struct Listing {
        tag_name: String,
        draft: bool,
    }
    let listing: Vec<Listing> = agent()
        .get(API)
        .set("Accept", "application/vnd.github+json")
        .call()
        .context("could not list provider releases")?
        .into_json()?;
    listing
        .into_iter()
        .filter(|release| !release.draft)
        .filter_map(|release| version_of_tag(&release.tag_name).map(|v| (v, release.tag_name)))
        .max()
        .map(|(_, tag)| tag)
        .ok_or_else(|| anyhow!("no provider releases are published"))
}

/// A verified release whose bundle has been unpacked.
pub struct Fetched {
    pub release: Release,
}

/// Downloads `tag`, verifies its manifest and bundle, and unpacks the bundle into `target`
/// (replacing it). Nothing is written unless every check passes.
pub fn fetch(tag: &str, target: &Path) -> Result<Fetched> {
    ensure!(
        version_of_tag(tag).is_some(),
        "{tag} is not a provider release tag"
    );
    let base = format!("{RELEASES}/{tag}");
    let manifest = download(&format!("{base}/provider-release.json"), 64 * 1024)?;
    let signature = String::from_utf8(download(
        &format!("{base}/provider-release.json.sig"),
        1024,
    )?)?;
    let release = verify_manifest(&manifest, &signature, SIGNING_DID)?;
    ensure!(
        release.tag == tag,
        "the signed manifest is for {}, not {tag}",
        release.tag
    );
    let bundle = download(&format!("{base}/{}", release.bundle.name), 16 * 1024 * 1024)?;
    ensure!(
        sha256_hex(&bundle) == release.bundle.sha256,
        "the bundle does not match the signed manifest"
    );
    unpack(
        &bundle,
        &format!("hail-provider-{}", release.release),
        target,
    )?;
    Ok(Fetched { release })
}

/// Unpacks the bundle's single top-level directory into `target`, atomically replacing it.
pub fn unpack(bundle: &[u8], root: &str, target: &Path) -> Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| anyhow!("invalid install directory"))?;
    fs::create_dir_all(parent)?;
    let staging = parent.join(".release-staging");
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    fs::create_dir_all(&staging)?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bundle));
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        ensure!(
            path.starts_with(root),
            "unexpected path {} in the bundle",
            path.display()
        );
        ensure!(
            entry.unpack_in(&staging)?,
            "unsafe path {} in the bundle",
            path.display()
        );
    }
    let unpacked = staging.join(root);
    ensure!(
        unpacked.join("compose.yaml").is_file(),
        "the bundle has no compose.yaml"
    );
    // Keep a registration document that may be published during an upgrade.
    if target.join("registration").is_dir() {
        fs::rename(target.join("registration"), unpacked.join("registration"))?;
    }
    if target.exists() {
        let previous = parent.join(".release-previous");
        if previous.exists() {
            fs::remove_dir_all(&previous)?;
        }
        fs::rename(target, &previous)?;
        fs::rename(&unpacked, target)?;
        fs::remove_dir_all(&previous)?;
    } else {
        fs::rename(&unpacked, target)?;
    }
    fs::remove_dir_all(&staging)?;
    Ok(())
}

/// This machine's release platform.
pub fn platform() -> Result<&'static str> {
    match std::env::consts::ARCH {
        "x86_64" => Ok("linux/amd64"),
        "aarch64" => Ok("linux/arm64"),
        other => bail!("unsupported architecture {other}"),
    }
}

/// Replaces the running hailctl with the release's binary for this machine, verified
/// against the signed manifest. Returns the installed path.
pub fn install_hailctl(release: &Release) -> Result<std::path::PathBuf> {
    let platform = platform()?;
    let expected = release
        .tools
        .hailctl
        .get(platform)
        .ok_or_else(|| anyhow!("the release has no hailctl for {platform}"))?;
    let asset = format!("hailctl-{}", platform.replace('/', "-"));
    let binary = download(
        &format!("{RELEASES}/{}/{asset}", release.tag),
        64 * 1024 * 1024,
    )?;
    ensure!(
        &sha256_hex(&binary) == expected,
        "{asset} does not match the signed manifest"
    );
    let path = std::env::current_exe().context("cannot locate the hailctl executable")?;
    let staged = path.with_extension("new");
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o755)
            .open(&staged)?;
        file.write_all(&binary)?;
        file.sync_all()?;
    }
    fs::rename(&staged, &path)?;
    Ok(path)
}

/// Refuses releases older than `current`; installing the same version again is allowed.
pub fn check_upgrade(current: &str, next: &str) -> Result<()> {
    match (parse_version(current), parse_version(next)) {
        (Some(current), Some(next)) if next >= current => Ok(()),
        (Some(_), Some(_)) => bail!("{next} is older than the installed {current}"),
        _ => bail!("invalid release version"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = "tests/fixtures/release";

    fn fixture(name: &str) -> Vec<u8> {
        fs::read(format!("{FIXTURE}/{name}")).unwrap()
    }
    fn fixture_did() -> String {
        String::from_utf8(fixture("signing.did")).unwrap()
    }

    #[test]
    fn verifies_a_manifest_signed_by_the_release_tooling() {
        let signature = String::from_utf8(fixture("provider-release.json.sig")).unwrap();
        let release = verify_manifest(
            &fixture("provider-release.json"),
            &signature,
            &fixture_did(),
        )
        .unwrap();
        assert_eq!(release.tag, format!("provider-v{}", release.release));
        assert_eq!(release.tools.hailctl.len(), 2);
        let bundle = fixture(&release.bundle.name);
        assert_eq!(sha256_hex(&bundle), release.bundle.sha256);
        let target = tempfile::tempdir().unwrap();
        unpack(
            &bundle,
            &format!("hail-provider-{}", release.release),
            &target.path().join("release"),
        )
        .unwrap();
        let pins = fs::read_to_string(target.path().join("release/release.env")).unwrap();
        assert!(pins.contains(&format!(
            "HAIL_PROVIDER_IMAGE={}@{}",
            release.images.provider.repository, release.images.provider.digest
        )));
    }

    #[test]
    fn refuses_tampering_and_other_keys() {
        let manifest = fixture("provider-release.json");
        let signature = String::from_utf8(fixture("provider-release.json.sig")).unwrap();
        let mut tampered = manifest.clone();
        let at = tampered.iter().position(|b| *b == b'0').unwrap();
        tampered[at] = b'1';
        assert!(verify_manifest(&tampered, &signature, &fixture_did()).is_err());
        assert!(verify_manifest(&manifest, &signature, SIGNING_DID).is_err());
        assert!(verify_manifest(&manifest, "AAAA", &fixture_did()).is_err());
    }

    #[test]
    fn pinned_key_is_a_valid_ed25519_did() {
        verifying_key(SIGNING_DID).unwrap();
    }

    #[test]
    fn orders_versions_and_refuses_downgrades() {
        assert_eq!(version_of_tag("provider-v1.10.0"), Some((1, 10, 0)));
        assert_eq!(version_of_tag("v1.0.0"), None);
        assert_eq!(parse_version("01.0.0"), None);
        assert!(check_upgrade("0.2.0", "0.10.0").is_ok());
        assert!(check_upgrade("0.2.0", "0.2.0").is_ok());
        assert!(check_upgrade("0.10.0", "0.9.9").is_err());
    }
}
