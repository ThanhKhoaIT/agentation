#!/usr/bin/env bash
# Build a signed .crx and update.xml for self-hosting the extension
# (Google Workspace "install from custom URL", no Chrome Web Store).
#
#   EXTENSION_KEY=~/secrets/agentation-extension.pem \
#   EXTENSION_UPDATE_URL=https://your-bucket.example.com/agentation/update.xml \
#   pnpm --filter agentation-extension pack:crx
#
# EXTENSION_KEY      Private key that signs the extension. It fixes the extension
#                    ID: keep it secret, back it up, reuse it for every release.
#                    Created on first run if the file doesn't exist.
# EXTENSION_UPDATE_URL  Public URL where update.xml will be hosted. The .crx must
#                    be uploaded next to it.
# CHROME_BIN         Chrome binary (default: macOS Google Chrome).
#
# Output (extension/release/): agentation-<version>.crx, update.xml, extension-id.txt
set -euo pipefail

: "${EXTENSION_KEY:?Set EXTENSION_KEY to the private key path}"
: "${EXTENSION_UPDATE_URL:?Set EXTENSION_UPDATE_URL to the public update.xml URL}"
CHROME_BIN="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

cd "$(dirname "$0")/.."
EXT_DIR="$PWD"
RELEASE_DIR="$EXT_DIR/release"

if [ ! -f "$EXTENSION_KEY" ]; then
  echo "Creating a new signing key at $EXTENSION_KEY (back it up: it defines the extension ID)"
  mkdir -p "$(dirname "$EXTENSION_KEY")"
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$EXTENSION_KEY" 2>/dev/null
  chmod 600 "$EXTENSION_KEY"
fi

EXTENSION_UPDATE_URL="$EXTENSION_UPDATE_URL" pnpm build >/dev/null
VERSION="$(node -p "require('./dist/manifest.json').version")"

# Extension ID = first 32 hex chars of sha256(public key DER), mapped 0-f → a-p
EXTENSION_ID="$(openssl rsa -in "$EXTENSION_KEY" -pubout -outform DER 2>/dev/null \
  | shasum -a 256 | head -c 32 | tr '0-9a-f' 'a-p')"

# Pack with a throwaway profile so an already running Chrome isn't involved
PROFILE_DIR="$(mktemp -d)"
trap 'rm -rf "$PROFILE_DIR"' EXIT
rm -f "$EXT_DIR/dist.crx"
"$CHROME_BIN" --user-data-dir="$PROFILE_DIR" --no-message-box \
  --pack-extension="$EXT_DIR/dist" --pack-extension-key="$EXTENSION_KEY" >/dev/null 2>&1 || true
if [ ! -f "$EXT_DIR/dist.crx" ]; then
  echo "Chrome did not produce dist.crx — check CHROME_BIN" >&2
  exit 1
fi

mkdir -p "$RELEASE_DIR"
CRX_NAME="agentation-$VERSION.crx"
mv "$EXT_DIR/dist.crx" "$RELEASE_DIR/$CRX_NAME"
CRX_URL="${EXTENSION_UPDATE_URL%/*}/$CRX_NAME"

cat > "$RELEASE_DIR/update.xml" <<XML
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='$EXTENSION_ID'>
    <updatecheck codebase='$CRX_URL' version='$VERSION' />
  </app>
</gupdate>
XML
echo "$EXTENSION_ID" > "$RELEASE_DIR/extension-id.txt"

echo "Extension ID: $EXTENSION_ID"
echo "Version:      $VERSION"
echo "Upload both files next to each other:"
echo "  $RELEASE_DIR/$CRX_NAME  →  $CRX_URL"
echo "  $RELEASE_DIR/update.xml →  $EXTENSION_UPDATE_URL"
