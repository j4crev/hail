#!/bin/sh
# Installs hailctl from one Hail provider release, then runs `hailctl install`.
#
#   curl -fsSL https://get.racrproto.com | sh
#
# This copy belongs to release @RELEASE_TAG@. It downloads that release's signed
# manifest, verifies the signature with the pinned release key using openssl, and
# installs hailctl only if its SHA-256 matches the signed manifest.
# Set HAILCTL_NO_RUN=1 to install without starting the installer. HAILCTL_INSTALL_DIR
# (default /usr/local/bin) and HAILCTL_RELEASE_BASE (default GitHub releases) exist
# for mirrors and tests; the signature is still checked against the pinned key.
set -eu

# Everything runs inside main, so a partially downloaded script does nothing.
main() {
  tag='@RELEASE_TAG@'
  repository="${HAILCTL_RELEASE_BASE:-https://github.com/j4crev/hail/releases/download}"
  bin="${HAILCTL_INSTALL_DIR:-/usr/local/bin}"
  public_key='@SIGNING_PUBLIC_KEY_PEM@'

  say() { printf '%s\n' "$*" >&2; }
  fail() { say "hailctl install: $*"; exit 1; }
  need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required"; }

  [ "$(uname -s)" = Linux ] || fail "Hail providers run on Linux"
  case "$(uname -m)" in
    x86_64 | amd64) platform=linux/amd64 ;;
    aarch64 | arm64) platform=linux/arm64 ;;
    *) fail "unsupported architecture $(uname -m); use amd64 or arm64" ;;
  esac
  for tool in curl openssl sha256sum awk mktemp install; do need "$tool"; done

  if [ "$(id -u)" -eq 0 ] || [ -w "$bin" ]; then sudo=''; else need sudo; sudo='sudo'; fi

  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT INT TERM
  asset="hailctl-$(printf '%s' "$platform" | tr / -)"
  fetch() {
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
      --output "$work/$1" "$repository/$tag/$1" || fail "could not download $1 from $tag"
  }
  say "Downloading hailctl from $tag..."
  fetch provider-release.json
  fetch provider-release.json.sig
  fetch "$asset"

  # Signature: Ed25519 over "hail.provider-release.v2\0" + the exact manifest bytes.
  printf '%s\n' "$public_key" > "$work/release.pub"
  { printf 'hail.provider-release.v2\000'; cat "$work/provider-release.json"; } > "$work/signed"
  signature=$(tr -d '\n' < "$work/provider-release.json.sig" | tr '_-' '/+')
  case $((${#signature} % 4)) in 2) signature="$signature==" ;; 3) signature="$signature=" ;; esac
  printf '%s' "$signature" | openssl base64 -d -A > "$work/signature" || fail "malformed release signature"
  openssl pkeyutl -verify -pubin -inkey "$work/release.pub" -rawin -in "$work/signed" \
    -sigfile "$work/signature" >/dev/null 2>&1 || fail "release signature verification failed"

  # The manifest is canonical, pretty-printed JSON: tools.hailctl lists one hash per platform.
  expected=$(awk -v platform="\"$platform\":" '
    /"hailctl": \{/ { inside = 1; next }
    inside && $1 == platform { gsub(/[",]/, "", $2); print $2; exit }
    inside && /\}/ { exit }' "$work/provider-release.json")
  [ -n "$expected" ] || fail "the signed manifest has no hailctl for $platform"
  actual=$(sha256sum "$work/$asset" | awk '{print $1}')
  [ "$actual" = "$expected" ] || fail "hailctl checksum does not match the signed manifest"

  $sudo install -m 0755 "$work/$asset" "$bin/hailctl"
  say "Installed $bin/hailctl ($tag, signature verified)."
  [ "${HAILCTL_NO_RUN:-}" = 1 ] && exit 0

  # stdin is this script when piped from curl; give the installer the terminal.
  if [ -r /dev/tty ]; then
    exec $sudo "$bin/hailctl" install --release "$tag" < /dev/tty
  fi
  say "No terminal is attached. Run: ${sudo:+sudo }$bin/hailctl install --release $tag"
}

main "$@"
