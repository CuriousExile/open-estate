#!/usr/bin/env bash
# One command for everything: ./run-everything.sh
#
# Installs dependencies, lints, type-checks, builds, runs all tests, synthesizes the CDK stacks and
# smoke-tests the local demo. No AWS account needed. Docker is optional (integration tests).
#
#   ./run-everything.sh             everything
#   ./run-everything.sh --quick     install, lint, quick tests only
#   ./run-everything.sh --no-docker skip the Docker integration tests
#   ./run-everything.sh --random    random property-test inputs (default: one fixed seed, so every
#                                   machine runs the same inputs and gets the same result)
#
# Needs bash (macOS or Linux; on Windows use WSL) and Node.js 22.12+ or 24+. Works offline when
# npm can reach a registry (or mirror) for `npm ci`. Only if the installed Node.js is missing or
# too old, and the machine is online, the version in .nvmrc is downloaded (checksum-verified) into
# .tools/ for this run. Nothing is installed system-wide.
set -euo pipefail
cd "$(dirname "$0")"

NODE_VERSION="$(tr -d '[:space:]' < .nvmrc)"

node_ok() {
  command -v node > /dev/null 2>&1 || return 1
  node -e '
    const [a, b] = process.versions.node.split(".").map(Number);
    process.exit((a === 22 && b >= 12) || a >= 24 ? 0 : 1);
  '
}

sha256() {
  if command -v sha256sum > /dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

install_node() {
  local os arch name dir
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) echo "Unsupported OS $(uname -s). Install Node.js ${NODE_VERSION} yourself, or use WSL." >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) echo "Unsupported CPU $(uname -m). Install Node.js ${NODE_VERSION} yourself." >&2; exit 1 ;;
  esac
  name="node-v${NODE_VERSION}-${os}-${arch}"
  dir=".tools/${name}"
  if [ ! -x "${dir}/bin/node" ]; then
    echo "Node.js ${NODE_VERSION} not found; downloading it into ${dir} (this run only) …"
    mkdir -p .tools
    local base="https://nodejs.org/dist/v${NODE_VERSION}"
    if ! curl -fsSL --connect-timeout 10 "${base}/${name}.tar.gz" -o ".tools/${name}.tar.gz"; then
      echo "" >&2
      echo "ERROR: Node.js $(node -v 2>/dev/null || echo 'is not installed') is too old and Node.js ${NODE_VERSION} could not be downloaded (offline?)." >&2
      echo "Install Node.js 22.12+ or 24+ and run ./run-everything.sh again." >&2
      rm -f ".tools/${name}.tar.gz"
      exit 1
    fi
    local expected actual
    expected="$(curl -fsSL "${base}/SHASUMS256.txt" | grep " ${name}.tar.gz\$" | cut -d' ' -f1)"
    actual="$(sha256 ".tools/${name}.tar.gz")"
    if [ -z "${expected}" ] || [ "${expected}" != "${actual}" ]; then
      echo "Checksum mismatch for ${name}.tar.gz; aborting." >&2
      rm -f ".tools/${name}.tar.gz"
      exit 1
    fi
    tar -xzf ".tools/${name}.tar.gz" -C .tools
    rm -f ".tools/${name}.tar.gz"
  fi
  export PATH="${PWD}/${dir}/bin:${PATH}"
}

if ! node_ok; then
  install_node
fi

exec node scripts/run-everything.mjs "$@"
