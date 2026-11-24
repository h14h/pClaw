#!/usr/bin/env bash
# Provision one persistent exe.dev VM for a pclaw multi-user SSH sandbox.
#
# Usage:
#   ./scripts/provision-exedev-user.sh <userId> <vmName> [pagesCode]
#
# Example:
#   ./scripts/provision-exedev-user.sh max grug-max ab12cd34
#
# Environment overrides:
#   MUSE_BIN         Local path to the statically linked x86-64 muse binary
#                    (default: resolved from `command -v muse`)
#   USER_PAGES_CODE  Per-user 6-24 char lowercase alphanumeric pages code
#                    (also accepted as 3rd positional arg)
#   PAGES_SITE_URL   Public pages site origin (default: https://grug.h14h.com)
#   SSH_WAIT_SECS    Seconds to wait for the new VM to accept SSH (default: 90)
#
# Safe to re-run: skips VM creation if <vmName>.exe.xyz already answers SSH,
# and installs muse, PDF tools (poppler-utils, pypdf, pdfplumber, pymupdf),
# headless browser automation (Node 24 + agent-browser + Chromium),
# grug-pages Astro site + CLI, and user-scope Muse skills idempotently.

set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "Usage: $0 <userId> <vmName> [pagesCode]" >&2
  exit 1
fi

USER_ID="$1"
VM_NAME="$2"
USER_PAGES_CODE="${3:-${USER_PAGES_CODE:-}}"
PAGES_SITE_URL="${PAGES_SITE_URL:-https://grug.h14h.com}"
SSH_WAIT_SECS="${SSH_WAIT_SECS:-90}"
VM_HOST="${VM_NAME}.exe.xyz"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ ! "$USER_ID" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ ]]; then
  echo "Error: invalid userId '$USER_ID' (use alphanumeric, '.', '_', '-')." >&2
  exit 1
fi

if [[ ! "$VM_NAME" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]; then
  echo "Error: invalid vmName '$VM_NAME' (use lowercase DNS label: a-z, 0-9, '-')." >&2
  exit 1
fi

if [ -n "$USER_PAGES_CODE" ] && [[ ! "$USER_PAGES_CODE" =~ ^[a-z0-9]{6,24}$ ]]; then
  echo "Error: invalid pagesCode '$USER_PAGES_CODE' (expected 6-24 lowercase alphanumeric chars)." >&2
  exit 1
fi

echo "==> Provisioning exe.dev VM '${VM_HOST}' for user '${USER_ID}'"

# 1. Create the VM only if it is not already reachable.
#    Note: omit --image; exe.dev's default image is boldsoftware/exeuntu.
if ssh "${SSH_OPTS[@]}" "$VM_HOST" "true" 2>/dev/null; then
  echo "    VM '${VM_HOST}' already exists and accepts SSH; skipping creation."
else
  echo "    Creating VM '${VM_NAME}' (default exeuntu image)..."
  ssh "${SSH_OPTS[@]}" exe.dev new --name "$VM_NAME"

  echo "    Waiting up to ${SSH_WAIT_SECS}s for SSH on '${VM_HOST}'..."
  deadline=$((SECONDS + SSH_WAIT_SECS))
  until ssh "${SSH_OPTS[@]}" "$VM_HOST" "true" 2>/dev/null; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "Error: timed out waiting for SSH on '${VM_HOST}'." >&2
      exit 1
    fi
    sleep 3
  done
  echo "    SSH is up on '${VM_HOST}'."
fi

# 2. Create workspace and inbox directories with private permissions.
echo "==> Creating ~/work, ~/inbox, and ~/.local/bin on '${VM_HOST}'"
ssh "${SSH_OPTS[@]}" "$VM_HOST" '
  set -euo pipefail
  mkdir -p "$HOME/work" "$HOME/inbox" "$HOME/.local/bin"
  chmod 700 "$HOME/work" "$HOME/inbox"
  for rc in "$HOME/.profile" "$HOME/.bashrc"; do
    touch "$rc"
    if ! grep -Fq '\''$HOME/.local/bin'\'' "$rc"; then
      printf '\''\nexport PATH="$HOME/.local/bin:$PATH"\n'\'' >> "$rc"
    fi
  done
'

# 3. Install Muse Code binary on the VM (idempotent).
LOCAL_MUSE="${MUSE_BIN:-$(command -v muse || true)}"
if [ -n "$LOCAL_MUSE" ]; then
  REAL_MUSE="$(readlink -f "$LOCAL_MUSE")"
  echo "==> Copying muse binary (${REAL_MUSE}) to '${VM_HOST}:~/.local/bin/muse'"
  ssh "${SSH_OPTS[@]}" "$VM_HOST" '
    set -euo pipefail
    tmp="$HOME/.local/bin/muse.tmp.$$"
    cat > "$tmp"
    chmod 755 "$tmp"
    mv -f "$tmp" "$HOME/.local/bin/muse"
  ' < "$REAL_MUSE"
  ssh "${SSH_OPTS[@]}" "$VM_HOST" '"$HOME/.local/bin/muse" --version || true'
else
  echo "Warning: local 'muse' binary not found in PATH (set MUSE_BIN=/path/to/muse to copy it)." >&2
fi

# 4. Install CLI and PDF essentials (poppler-utils, ripgrep, curl, jq, pypdf, pdfplumber, pymupdf) idempotently.
echo "==> Installing poppler-utils, ripgrep, curl, jq and Python PDF tools (pypdf, pdfplumber, pymupdf) on '${VM_HOST}'"
ssh "${SSH_OPTS[@]}" "$VM_HOST" '
  set -euo pipefail
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq poppler-utils python3 ripgrep curl jq
  sudo uv pip install --system --break-system-packages pypdf pdfplumber pymupdf
  python3 -c "import pypdf, pdfplumber, pymupdf; print(\"PDF libs OK:\", pypdf.__version__, pdfplumber.__version__, \"pymupdf\")"
  pdftotext -v 2>&1 | head -n 1 || true
'

# 5. Install Node.js 24, agent-browser, and headless Chromium + OS deps idempotently.
echo "==> Installing Node.js 24, agent-browser, and headless Chromium on '${VM_HOST}'"
ssh "${SSH_OPTS[@]}" "$VM_HOST" '
  set -euo pipefail
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
  fi
  if ! command -v agent-browser >/dev/null 2>&1; then
    sudo npm install -g agent-browser
  fi
  agent-browser install --with-deps
  sudo apt-get clean
  agent-browser --version
'

# 6. Register agent-browser's core skill in Muse at user scope (idempotent).
echo "==> Registering agent-browser user-scope Muse skill on '${VM_HOST}'"
ssh "${SSH_OPTS[@]}" "$VM_HOST" '
  set -euo pipefail
  if [ -x "$HOME/.local/bin/muse" ] && [ -d /usr/lib/node_modules/agent-browser/skill-data/core ]; then
    "$HOME/.local/bin/muse" skills install /usr/lib/node_modules/agent-browser/skill-data/core --scope user --name agent-browser --force
  else
    echo "Warning: skipping agent-browser Muse skill install (muse binary or skill-data/core missing)." >&2
  fi
'

# 7. Sync sites/grug-pages template, install deps, write ~/.config/grug-pages.json, and symlink grug-page CLI.
SITE_SRC="${REPO_ROOT}/sites/grug-pages"
if [ -d "$SITE_SRC" ]; then
  echo "==> Syncing grug-pages template to '${VM_HOST}:~/site' and installing npm dependencies"
  tar -czf - --exclude=node_modules --exclude=dist --exclude=.astro -C "$SITE_SRC" . | \
    ssh "${SSH_OPTS[@]}" "$VM_HOST" '
      set -euo pipefail
      mkdir -p "$HOME/site" "$HOME/work/pages" "$HOME/.config" "$HOME/.local/bin"
      tar -xzf - -C "$HOME/site"
      chmod 755 "$HOME/site/bin/grug-page.mjs"
      ln -sfn "$HOME/site/bin/grug-page.mjs" "$HOME/.local/bin/grug-page"
      cd "$HOME/site"
      npm ci --no-audit --no-fund
    '

  if [ -n "$USER_PAGES_CODE" ]; then
    echo "==> Writing ~/.config/grug-pages.json (userCode=${USER_PAGES_CODE}) on '${VM_HOST}'"
    ssh "${SSH_OPTS[@]}" "$VM_HOST" "USER_PAGES_CODE=$(printf '%q' "$USER_PAGES_CODE") PAGES_SITE_URL=$(printf '%q' "$PAGES_SITE_URL") node -e '
      const fs = require(\"node:fs\");
      const path = require(\"node:path\");
      const os = require(\"node:os\");
      const home = os.homedir();
      const cfgPath = path.join(home, \".config\", \"grug-pages.json\");
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      const cfg = {
        userCode: process.env.USER_PAGES_CODE,
        siteUrl: process.env.PAGES_SITE_URL,
        workDir: path.join(home, \"work\"),
        siteDir: path.join(home, \"site\"),
      };
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + \"\\n\", { mode: 0o600 });
    '"
  else
    echo "    Note: USER_PAGES_CODE not provided; skipping ~/.config/grug-pages.json write."
  fi
else
  echo "Warning: sites/grug-pages not found at '${SITE_SRC}'; skipping site provisioning." >&2
fi

# 8. Install user-scope Muse skills (grug-page, unslop, ultracave) idempotently.
SKILLS_SRC="${REPO_ROOT}/bots/grug/skills"
if [ -d "$SKILLS_SRC" ]; then
  echo "==> Installing user-scope Muse skills (grug-page, unslop, ultracave) on '${VM_HOST}'"
  tar -czf - -C "$SKILLS_SRC" grug-page unslop ultracave | \
    ssh "${SSH_OPTS[@]}" "$VM_HOST" '
      set -euo pipefail
      tmp_skills=$(mktemp -d)
      trap '\''rm -rf "$tmp_skills"'\'' EXIT
      tar -xzf - -C "$tmp_skills"
      if [ -x "$HOME/.local/bin/muse" ]; then
        for skill in grug-page unslop ultracave; do
          "$HOME/.local/bin/muse" skills install "$tmp_skills/$skill" --scope user --name "$skill" --force
        done
        "$HOME/.local/bin/muse" skills list --source user --json
      else
        echo "Warning: skipping grug-page/unslop/ultracave Muse skill install (muse binary missing)." >&2
      fi
    '
fi

cat <<EOF

==> Provisioning complete for user '${USER_ID}' on '${VM_HOST}'.

Next steps (manual — never store credentials in git):

1. Seed Muse Code authentication on the VM:
     ssh ${VM_HOST} '/home/exedev/.local/bin/muse login'
   (Or copy the Muse auth token/credentials file securely into the VM's XDG config/data dir.)

2. Verify headless Muse execution:
     ssh ${VM_HOST} '/home/exedev/.local/bin/muse exec --json --workspace ~/work --approval-mode never --disable-sandbox --disable-request-user-input --no-foreign-personal-context "Reply with OK"'

3. Add this user entry under "users" in your bot's ~/.pclaw/config.json:
     "${USER_ID}": {
       "name": "${USER_ID}",
       "timeZone": "America/Los_Angeles",
       "telegram": "<TELEGRAM_USER_ID>",
       "discord": "<DISCORD_USER_ID>",
       "sandbox": {
         "type": "ssh",
         "host": "${VM_HOST}",
         "workDir": "~/work",
         "inboxDir": "~/inbox",
         "museBin": "/home/exedev/.local/bin/muse"
       }
     }
EOF
