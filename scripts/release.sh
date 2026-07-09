#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

RUNTIME_JS_FILES=(
  background.js
  content-script.js
  shadow-dom-bridge.js
  utils.js
  constants.js
  popup-main.js
  popup-persistence.js
  popup-storage-helpers.js
)

PACKAGE_PATHS=(
  LICENSE
  manifest.json
  background.js
  content-script.js
  shadow-dom-bridge.js
  utils.js
  constants.js
  popup-main.js
  popup-persistence.js
  popup-storage-helpers.js
  popup.html
  styles.css
  whats-new.html
  whats-new.css
  icons
  assets
)

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

run_code_checks() {
  need_cmd node

  node --test tests/
  echo "OK: unit tests passed"

  local file
  for file in "${RUNTIME_JS_FILES[@]}"; do
    node --check "$file"
  done
  echo "OK: runtime JavaScript syntax passed"
}

verify_archive_references() {
  local zip_path="$1"

  python3 - "$zip_path" <<'PY'
import fnmatch
import json
import posixpath
import re
import sys
import zipfile
from html.parser import HTMLParser
from urllib.parse import unquote, urlsplit

zip_path = sys.argv[1]

with zipfile.ZipFile(zip_path) as archive:
    file_names = {
        name for name in archive.namelist()
        if name and not name.endswith('/')
    }

    required_files = {
        'LICENSE',
        'assets/icons/check.svg',
    }
    missing_required_files = sorted(required_files - file_names)
    if missing_required_files:
        print(
            'ERROR: archive is missing required package files: %s'
            % ', '.join(missing_required_files),
            file=sys.stderr,
        )
        sys.exit(1)

    forbidden_exact = {
        '.nvmrc',
        'package-lock.json',
        'package.json',
    }
    forbidden_prefixes = (
        '.agents/',
        'node_modules/',
        'plans/',
        'tests/',
    )
    forbidden = sorted(
        name for name in file_names
        if name in forbidden_exact or name.startswith(forbidden_prefixes)
    )
    if forbidden:
        print(
            'ERROR: archive contains development-only files: %s' % ', '.join(forbidden),
            file=sys.stderr,
        )
        sys.exit(1)

    references = []

    def add_reference(source, raw_value, allow_glob=False):
        if not isinstance(raw_value, str):
            return

        value = raw_value.strip()
        if not value or value.startswith('#'):
            return

        parsed = urlsplit(value)
        if parsed.scheme or parsed.netloc or value.startswith('//'):
            return

        path = unquote(parsed.path).strip()
        if not path:
            return

        if path.startswith('/'):
            resolved = posixpath.normpath(path.lstrip('/'))
        else:
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(source), path))

        references.append((source, resolved, allow_glob))

    manifest = json.loads(archive.read('manifest.json'))

    def add_icon_references(source, value):
        if isinstance(value, str):
            add_reference(source, value)
        elif isinstance(value, dict):
            for icon_path in value.values():
                add_reference(source, icon_path)

    add_icon_references('manifest.json', manifest.get('icons'))

    background = manifest.get('background') or {}
    add_reference('manifest.json', background.get('service_worker'))
    for script_path in background.get('scripts') or []:
        add_reference('manifest.json', script_path)

    for action_key in ('action', 'browser_action', 'page_action'):
        action = manifest.get(action_key) or {}
        add_reference('manifest.json', action.get('default_popup'))
        add_icon_references('manifest.json', action.get('default_icon'))

    for content_script in manifest.get('content_scripts') or []:
        for file_key in ('js', 'css'):
            for script_path in content_script.get(file_key) or []:
                add_reference('manifest.json', script_path)

    add_reference('manifest.json', manifest.get('options_page'))
    add_reference('manifest.json', (manifest.get('options_ui') or {}).get('page'))
    add_reference('manifest.json', manifest.get('devtools_page'))
    add_reference('manifest.json', (manifest.get('side_panel') or {}).get('default_path'))

    for override_path in (manifest.get('chrome_url_overrides') or {}).values():
        add_reference('manifest.json', override_path)
    for sandbox_page in (manifest.get('sandbox') or {}).get('pages') or []:
        add_reference('manifest.json', sandbox_page)
    for resource_group in manifest.get('web_accessible_resources') or []:
        for resource_path in resource_group.get('resources') or []:
            add_reference('manifest.json', resource_path, allow_glob=True)

    class ReferenceParser(HTMLParser):
        def __init__(self, source):
            super().__init__(convert_charrefs=True)
            self.source = source

        def handle_starttag(self, _tag, attrs):
            for attribute, value in attrs:
                if attribute.lower() in ('src', 'href'):
                    add_reference(self.source, value)

        def handle_startendtag(self, tag, attrs):
            self.handle_starttag(tag, attrs)

    css_url_pattern = re.compile(
        r'url\(\s*(?P<quote>[\'\"]?)(?P<value>.*?)(?P=quote)\s*\)',
        re.IGNORECASE,
    )

    for name in sorted(file_names):
        lower_name = name.lower()
        if lower_name.endswith('.html'):
            parser = ReferenceParser(name)
            parser.feed(archive.read(name).decode('utf-8'))
            parser.close()
        elif lower_name.endswith('.css'):
            css_text = archive.read(name).decode('utf-8')
            for match in css_url_pattern.finditer(css_text):
                add_reference(name, match.group('value'))

    missing = []
    for source, target, allow_glob in references:
        if allow_glob and any(character in target for character in '*?['):
            if not any(fnmatch.fnmatchcase(name, target) for name in file_names):
                missing.append((source, target))
        elif target not in file_names:
            missing.append((source, target))

    if missing:
        for source, target in sorted(set(missing)):
            print(f'ERROR: {source} references missing archive file: {target}', file=sys.stderr)
        sys.exit(1)

    print(
        'OK: verified %d local manifest/HTML/CSS references in archive' % len(references)
    )
PY
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

  run_code_checks
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
  zip -r "$zip_path" "${PACKAGE_PATHS[@]}" -x "*.DS_Store"

  verify_archive_references "$zip_path"

  echo "Built $zip_path"
  unzip -l "$zip_path"
}

main() {
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
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
