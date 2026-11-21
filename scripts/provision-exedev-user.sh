#!/usr/bin/env bash
# Provision one persistent exe.dev VM for a pclaw multi-user SSH sandbox.
#
# Usage:
#   ./scripts/provision-exedev-user.sh <userId> <vmName>
#
# Example:
#   ./scripts/provision-exedev-user.sh max grug-max
#
# Environment overrides:
#   EXEDEV_IMAGE   Base VM image (default: boldsoftware/exeuntu)
#   MUSE_BIN       Local path to the statically linked x86-64 muse binary
#                  (default: resolved from `command -v muse`)
#   SSH_WAIT_SECS  Seconds to wait for the new VM to accept SSH (default: 90)
#
# Safe to re-run: skips VM creation if <vmName>.exe.xyz already answers SSH,
# and installs muse + Python PDF packages idempotently.

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <userId> <vmName>" >&2
  exit 1
fi

USER_ID="$1"
VM_NAME="$2"
EXEDEV_IMAGE="${EXEDEV_IMAGE:-boldsoftware/exeuntu}"
SSH_WAIT_SECS="${SSH_WAIT_SECS:-90}"
VM_HOST="${VM_NAME}.exe.xyz"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)

if [[ ! "$USER_ID" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ ]]; then
  echo "Error: invalid userId '$USER_ID' (use alphanumeric, '.', '_', '-')." >&2
  exit 1
fi

if [[ ! "$VM_NAME" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]; then
  echo "Error: invalid vmName '$VM_NAME' (use lowercase DNS label: a-z, 0-9, '-')." >&2
  exit 1
fi

echo "==> Provisioning exe.dev VM '${VM_HOST}' for user '${USER_ID}'"

# 1. Create the VM only if it is not already reachable.
if ssh "${SSH_OPTS[@]}" "$VM_HOST" "true" 2>/dev/null; then
  echo "    VM '${VM_HOST}' already exists and accepts SSH; skipping creation."
else
  echo "    Creating VM '${VM_NAME}' from image '${EXEDEV_IMAGE}'..."
  ssh "${SSH_OPTS[@]}" exe.dev new --image "$EXEDEV_IMAGE" --name "$VM_NAME"

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

# 4. Install Python 3 + PDF inspection essentials (pypdf, pdfplumber) idempotently.
echo "==> Installing Python 3 and PDF tools (pypdf, pdfplumber) on '${VM_HOST}'"
ssh "${SSH_OPTS[@]}" "$VM_HOST" '
  set -euo pipefail
  if ! command -v python3 >/dev/null 2>&1 || ! python3 -m venv --help >/dev/null 2>&1; then
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 python3-venv python3-pip
  fi
  if [ ! -x "$HOME/.local/venv/bin/python" ]; then
    python3 -m venv "$HOME/.local/venv"
  fi
  "$HOME/.local/venv/bin/pip" install --quiet --upgrade pip pypdf pdfplumber
  ln -sf "$HOME/.local/venv/bin/python" "$HOME/.local/bin/python-pdf"
  "$HOME/.local/venv/bin/python" -c "import pypdf, pdfplumber; print(\"PDF libs OK:\", pypdf.__version__, pdfplumber.__version__)"
'

cat <<EOF

==> Provisioning complete for user '${USER_ID}' on '${VM_HOST}'.

Next steps (manual — never store credentials in git):

1. Seed Muse Code authentication on the VM:
     ssh ${VM_HOST} '~/.local/bin/muse login'
   (Or copy the Muse auth token/credentials file securely into the VM's XDG config/data dir.)

2. Verify headless Muse execution:
     ssh ${VM_HOST} '~/.local/bin/muse exec --json --workspace ~/work --approval-mode never --disable-sandbox --disable-request-user-input --no-foreign-personal-context "Reply with OK"'

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
         "museBin": "~/.local/bin/muse"
       }
     }
EOF
