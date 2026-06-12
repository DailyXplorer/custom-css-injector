#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: bash scripts/release.sh {check|build}" >&2
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

get_version() {
  python3 -c "import json;print(json.load(open('manifest.json'))['version'])"
}

check() {
  need_cmd python3
  local version
  version="$(get_version)"
  local release_id
  release_id="id=\"v${version//./-}\""

  echo "OK: manifest version $version"

  if grep -Fq "**Version:** $version" README.md; then
    echo "OK: README.md version matches $version"
  else
    die "README.md does not contain **Version:** $version"
  fi

  if grep -Fq "$release_id" whats-new.html; then
    echo "OK: whats-new.html contains $release_id"
  else
    die "whats-new.html does not contain $release_id"
  fi

  if [ -z "$(git status --porcelain)" ]; then
    echo "OK: working tree clean"
  else
    git status --short >&2
    die "working tree not clean"
  fi
}

build() {
  check
  need_cmd zip
  need_cmd unzip

  local version
  version="$(get_version)"
  local zip_path
  zip_path="dist/custom-css-injector-$version.zip"

  mkdir -p dist
  rm -f "$zip_path"
  zip -r "$zip_path" \
    manifest.json background.js content-script.js shadow-dom-bridge.js \
    utils.js constants.js popup-main.js popup-storage-helpers.js \
    popup.html styles.css whats-new.html whats-new.css icons assets \
    -x "*.DS_Store"

  echo "Built $zip_path"
  unzip -l "$zip_path"
}

case "${1:-}" in
  check)
    check
    ;;
  build)
    build
    ;;
  *)
    usage
    exit 1
    ;;
esac
