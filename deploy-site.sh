#!/usr/bin/env bash
#
# Deploys the static portament.jp landing pages (HTML + assets) to S3 and
# invalidates the affected paths on CloudFront (E86W76PW0HMG8).
#
#   local files --aws s3 cp--> s3://portament-lps/hpreconstruction/
#                                 (CloudFront OriginPath = /hpreconstruction —
#                                  uploading to any other prefix breaks the site)
#                               --aws cloudfront create-invalidation-->
#                                 E86W76PW0HMG8
#
# Idempotent: safe to re-run, always re-uploads every tracked file.
#
# Usage:
#   ./deploy-site.sh                # uploads + invalidates
#   ./deploy-site.sh --dry-run      # prints what would happen, touches nothing
#   AWS_PROFILE=admin ./deploy-site.sh
#
set -euo pipefail

# ─────────────────────────────── configuration ───────────────────────────────
REGION="us-east-1"
BUCKET="portament-lps"
BUCKET_PREFIX="hpreconstruction"          # CloudFront OriginPath — do not change
DISTRIBUTION_ID="E86W76PW0HMG8"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# HTML pages at the repo root that make up the site.
HTML_FILES=(
  "index.html"
  "agentmaker.html"
  "agentpartner.html"
  "allrounder.html"
  "wavelopment.html"
  "privacy-policy.html"
  "security-policy.html"
)

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

# ──────────────────────────────── helpers ────────────────────────────────────
say()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[0;32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[0;33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[0;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

run() {
  # Prints the command it would run; only executes it when not --dry-run.
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '  [dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

# ─────────────────────────────── 0. preflight ────────────────────────────────
say "Preflight"
for bin in aws; do
  command -v "$bin" >/dev/null || die "missing required tool: $bin"
done

for f in "${HTML_FILES[@]}"; do
  [[ -f "$SCRIPT_DIR/$f" ]] || die "expected HTML file not found: $f"
done
[[ -d "$SCRIPT_DIR/assets" ]] || die "assets/ directory not found"
[[ -f "$SCRIPT_DIR/.nojekyll" ]] || die ".nojekyll not found"

if [[ $DRY_RUN -eq 1 ]]; then
  warn "--dry-run: no AWS calls will be made"
else
  actual_account="$(aws sts get-caller-identity --query Account --output text)"
  ok "authenticated on account $actual_account as $(aws sts get-caller-identity --query Arn --output text)"
fi

DEST="s3://$BUCKET/$BUCKET_PREFIX"

# ────────────────────────────── 1. HTML pages ─────────────────────────────────
say "S3: uploading HTML pages to $DEST/"
INVALIDATION_PATHS=("/")
for f in "${HTML_FILES[@]}"; do
  run aws --region "$REGION" s3 cp "$SCRIPT_DIR/$f" "$DEST/$f" \
    --content-type "text/html; charset=utf-8" \
    --cache-control "public, max-age=300"
  ok "$f"
  INVALIDATION_PATHS+=("/$f")
done

# ──────────────────────────────── 2. .nojekyll ────────────────────────────────
say "S3: uploading .nojekyll"
run aws --region "$REGION" s3 cp "$SCRIPT_DIR/.nojekyll" "$DEST/.nojekyll"
ok ".nojekyll"

# ───────────────────────────────── 3. assets/ ─────────────────────────────────
say "S3: uploading assets/ (recursive, content-type auto-detected)"
run aws --region "$REGION" s3 cp "$SCRIPT_DIR/assets" "$DEST/assets" --recursive
ok "assets/"

# ─────────────────────────── 4. CloudFront invalidation ──────────────────────
say "CloudFront: invalidating ${#INVALIDATION_PATHS[@]} paths on $DISTRIBUTION_ID"
printf '  %s\n' "${INVALIDATION_PATHS[@]}"
run aws --region "$REGION" cloudfront create-invalidation \
  --distribution-id "$DISTRIBUTION_ID" \
  --paths "${INVALIDATION_PATHS[@]}"
ok "invalidation requested"

# ────────────────────────────────── summary ──────────────────────────────────
say "Done"
if [[ $DRY_RUN -eq 1 ]]; then
  warn "--dry-run: nothing was uploaded or invalidated"
else
  cat <<EOF
  Bucket        $DEST/
  Distribution  $DISTRIBUTION_ID
  Invalidated   ${INVALIDATION_PATHS[*]}

  Propagation takes a few minutes. Hard-reload the affected pages to verify.
EOF
fi
