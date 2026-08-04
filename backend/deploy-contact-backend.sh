#!/usr/bin/env bash
#
# Deploys the portament.jp contact-form backend:
#
#   browser --POST /api/contact--> CloudFront (E86W76PW0HMG8)
#           --/api/* behaviour--> Lambda function URL --> SES --> sales@portament.jp
#
# Idempotent: safe to re-run. Each step checks for existing state first.
#
# REQUIRES CREDENTIALS WITH lambda:*, iam:*, ses:* ON ACCOUNT 396115588530.
# The `opsguide` profile has these. See backend/README.md.
#
# Usage:
#   ./backend/deploy-contact-backend.sh              # prompts before touching CloudFront
#   ./backend/deploy-contact-backend.sh --yes        # no prompts
#   AWS_PROFILE=admin ./backend/deploy-contact-backend.sh
#
set -euo pipefail

# ─────────────────────────────── configuration ───────────────────────────────
# Default to the local "opsguide" named profile for interactive/manual runs, but
# don't force it when that profile doesn't exist (e.g. GitHub Actions, where
# aws-actions/configure-aws-credentials@v4 exports ambient AWS_ACCESS_KEY_ID /
# AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN env vars instead of a named profile —
# setting AWS_PROFILE to a nonexistent profile makes every `aws` call fail with
# "The config profile (opsguide) could not be found" before it even gets to try
# those env credentials).
if [[ -n "${AWS_PROFILE:-}" ]]; then
  export AWS_PROFILE
elif aws configure list-profiles 2>/dev/null | grep -qx opsguide; then
  export AWS_PROFILE=opsguide
fi

ACCOUNT_ID="396115588530"
REGION="us-east-1"              # SES already has production access here (50k/day)
DOMAIN="portament.jp"
HOSTED_ZONE_ID="Z01428353Q0LWHAA8XVVS"
DISTRIBUTION_ID="E86W76PW0HMG8"

RECIPIENT_EMAIL="${RECIPIENT_EMAIL:-sales@portament.jp}"
SENDER_EMAIL="${SENDER_EMAIL:-noreply@portament.jp}"
ALLOWED_ORIGINS="https://portament.jp,https://www.portament.jp"

FUNCTION_NAME="portament-contact-form"
ROLE_NAME="portament-contact-form-role"
ORIGIN_ID="contact-lambda"
PATH_PATTERN="/api/*"
SECRET_HEADER="x-portament-origin"

# AWS managed policy IDs
CACHE_POLICY_DISABLED="4135ea2d-6df8-44a3-9df3-4b5a84be39ad"           # CachingDisabled
ORIGIN_REQ_ALL_VIEWER_EXCEPT_HOST="b689b0a8-53d0-40ab-baf2-68738e2966ac" # AllViewerExceptHostHeader

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/.build"
SECRET_FILE="$SCRIPT_DIR/.origin-secret"

ASSUME_YES=0
[[ "${1:-}" == "--yes" || "${1:-}" == "-y" ]] && ASSUME_YES=1

# ──────────────────────────────── helpers ────────────────────────────────────
say()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[0;32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[0;33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[0;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

confirm() {
  [[ $ASSUME_YES -eq 1 ]] && return 0
  read -r -p "  $1 [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

aws_() { aws --region "$REGION" "$@"; }

# ─────────────────────────────── 0. preflight ────────────────────────────────
say "Preflight"
for bin in aws jq node npm zip; do
  command -v "$bin" >/dev/null || die "missing required tool: $bin"
done

actual_account="$(aws sts get-caller-identity --query Account --output text)"
[[ "$actual_account" == "$ACCOUNT_ID" ]] \
  || die "profile '${AWS_PROFILE:-<none — using ambient credentials>}' is on account $actual_account, expected $ACCOUNT_ID"
ok "authenticated on $ACCOUNT_ID as $(aws sts get-caller-identity --query Arn --output text)"

caller_arn="$(aws sts get-caller-identity --query Arn --output text)"
missing=""
for action in lambda:CreateFunction iam:CreateRole iam:PassRole ses:CreateEmailIdentity; do
  decision="$(aws iam simulate-principal-policy \
    --policy-source-arn "$caller_arn" --action-names "$action" \
    --query 'EvaluationResults[0].EvalDecision' --output text 2>/dev/null || echo unknown)"
  [[ "$decision" == "allowed" ]] || missing="$missing $action"
done
if [[ -n "$missing" ]]; then
  warn "these actions appear denied for the current principal:$missing"
  confirm "Continue anyway?" || die "aborted — use credentials with the required permissions"
fi

# ────────────────────────── 1. SES domain identity ───────────────────────────
say "SES: domain identity for $DOMAIN (region $REGION)"
if aws_ sesv2 get-email-identity --email-identity "$DOMAIN" >/dev/null 2>&1; then
  ok "identity already exists"
else
  aws_ sesv2 create-email-identity --email-identity "$DOMAIN" \
    --dkim-signing-attributes NextSigningKeyLength=RSA_2048_BIT >/dev/null
  ok "identity created"
fi

say "Route 53: publishing Easy DKIM CNAMEs"
tokens="$(aws_ sesv2 get-email-identity --email-identity "$DOMAIN" \
  --query 'DkimAttributes.Tokens' --output json)"
token_count="$(jq 'length' <<<"$tokens")"
[[ "$token_count" -eq 3 ]] || die "expected 3 DKIM tokens, got $token_count"

changes="$(jq -n --argjson tokens "$tokens" --arg domain "$DOMAIN" '
  { Comment: "SES Easy DKIM for contact form",
    Changes: [ $tokens[] | {
      Action: "UPSERT",
      ResourceRecordSet: {
        Name: (. + "._domainkey." + $domain),
        Type: "CNAME",
        TTL: 1800,
        ResourceRecords: [ { Value: (. + ".dkim.amazonses.com") } ]
      } } ] }')"

change_id="$(aws route53 change-resource-record-sets \
  --hosted-zone-id "$HOSTED_ZONE_ID" --change-batch "$changes" \
  --query 'ChangeInfo.Id' --output text)"
ok "3 DKIM CNAMEs upserted ($change_id)"
# NOTE: apex MX (Google Workspace) and existing TXT records are untouched by design.

say "Waiting for SES to verify DKIM (up to 10 min)"
for i in $(seq 1 60); do
  status="$(aws_ sesv2 get-email-identity --email-identity "$DOMAIN" \
    --query 'DkimAttributes.Status' --output text)"
  [[ "$status" == "SUCCESS" ]] && { ok "DKIM verified"; break; }
  printf '  … %s (%ds)\r' "$status" $((i * 10))
  sleep 10
done
[[ "${status:-}" == "SUCCESS" ]] || warn "DKIM still $status — deploy continues; sending will fail until verified"

# ───────────────────────────── 2. IAM role ───────────────────────────────────
say "IAM: execution role $ROLE_NAME"
if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  ok "role already exists"
else
  aws iam create-role --role-name "$ROLE_NAME" \
    --description "Execution role for the portament.jp contact form Lambda" \
    --assume-role-policy-document '{
      "Version": "2012-10-17",
      "Statement": [{
        "Effect": "Allow",
        "Principal": {"Service": "lambda.amazonaws.com"},
        "Action": "sts:AssumeRole"
      }]
    }' >/dev/null
  ok "role created"
fi

aws iam attach-role-policy --role-name "$ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
ok "CloudWatch Logs policy attached"

aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name ses-send \
  --policy-document "$(jq -n --arg region "$REGION" --arg acct "$ACCOUNT_ID" \
    --arg domain "$DOMAIN" --arg sender "$SENDER_EMAIL" '
    { Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Action: ["ses:SendEmail"],
        Resource: [ ("arn:aws:ses:" + $region + ":" + $acct + ":identity/" + $domain) ],
        Condition: { StringEquals: { "ses:FromAddress": $sender } }
      }] }')"
ok "scoped ses:SendEmail policy attached (From must be $SENDER_EMAIL)"

ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)"

# ───────────────────────── 3. build the deployment zip ───────────────────────
say "Build: packaging Lambda bundle"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
cp "$SCRIPT_DIR/contact/index.mjs" "$SCRIPT_DIR/contact/validate.mjs" "$BUILD_DIR/"
# The SDK is vendored rather than relying on the runtime's bundled copy, which
# AWS documents as convenience-only and subject to change between runtime patches.
# `npm init -y` would derive the package name from the directory (".build") and
# fail with "Invalid name", so the manifest is written directly.
(cd "$BUILD_DIR" \
  && printf '%s' '{"name":"portament-contact-form","version":"1.0.0","private":true}' > package.json \
  && npm install --omit=dev --no-audit --no-fund @aws-sdk/client-sesv2 >/dev/null 2>&1)
(cd "$BUILD_DIR" && zip -qr function.zip . -x '*.DS_Store')
ok "bundle: $(du -h "$BUILD_DIR/function.zip" | cut -f1)"

# ─────────────────────────── 4. origin shared secret ─────────────────────────
say "Origin secret"
if [[ -f "$SECRET_FILE" ]]; then
  ORIGIN_SECRET="$(cat "$SECRET_FILE")"
  ok "reusing secret from $SECRET_FILE"
elif existing="$(aws_ lambda get-function-configuration --function-name "$FUNCTION_NAME" \
      --query 'Environment.Variables.ORIGIN_SECRET' --output text 2>/dev/null)" \
     && [[ -n "$existing" && "$existing" != "None" ]]; then
  ORIGIN_SECRET="$existing"
  printf '%s' "$ORIGIN_SECRET" > "$SECRET_FILE"
  ok "recovered secret from the deployed function"
else
  ORIGIN_SECRET="$(openssl rand -hex 24)"
  printf '%s' "$ORIGIN_SECRET" > "$SECRET_FILE"
  chmod 600 "$SECRET_FILE"
  ok "new secret generated → $SECRET_FILE (gitignored, keep it)"
fi

ENV_JSON="$(jq -n --arg r "$RECIPIENT_EMAIL" --arg s "$SENDER_EMAIL" \
  --arg sec "$ORIGIN_SECRET" --arg o "$ALLOWED_ORIGINS" '
  { Variables: { RECIPIENT_EMAIL: $r, SENDER_EMAIL: $s, ORIGIN_SECRET: $sec, ALLOWED_ORIGINS: $o } }')"

# ───────────────────────────── 5. Lambda function ────────────────────────────
say "Lambda: $FUNCTION_NAME"
if aws_ lambda get-function --function-name "$FUNCTION_NAME" >/dev/null 2>&1; then
  aws_ lambda update-function-code --function-name "$FUNCTION_NAME" \
    --zip-file "fileb://$BUILD_DIR/function.zip" >/dev/null
  aws_ lambda wait function-updated --function-name "$FUNCTION_NAME"
  aws_ lambda update-function-configuration --function-name "$FUNCTION_NAME" \
    --environment "$ENV_JSON" --timeout 10 --memory-size 256 >/dev/null
  aws_ lambda wait function-updated --function-name "$FUNCTION_NAME"
  ok "function updated"
else
  # The role needs a moment to propagate before Lambda will accept it.
  for attempt in 1 2 3 4 5; do
    if aws_ lambda create-function --function-name "$FUNCTION_NAME" \
        --runtime nodejs22.x --handler index.handler --role "$ROLE_ARN" \
        --zip-file "fileb://$BUILD_DIR/function.zip" \
        --environment "$ENV_JSON" --timeout 10 --memory-size 256 \
        --description "portament.jp contact form -> SES" >/dev/null 2>&1; then
      ok "function created"
      break
    fi
    [[ $attempt -eq 5 ]] && die "could not create function (role propagation or permissions)"
    sleep 5
  done
  aws_ lambda wait function-active --function-name "$FUNCTION_NAME"
fi

aws_ logs put-retention-policy --log-group-name "/aws/lambda/$FUNCTION_NAME" \
  --retention-in-days 90 >/dev/null 2>&1 || warn "could not set log retention (log group may not exist yet)"

# ─────────────────────────── 6. Lambda function URL ──────────────────────────
say "Lambda function URL"
if aws_ lambda get-function-url-config --function-name "$FUNCTION_NAME" >/dev/null 2>&1; then
  ok "function URL already configured"
else
  aws_ lambda create-function-url-config --function-name "$FUNCTION_NAME" \
    --auth-type NONE >/dev/null
  # Public invoke permission; abuse is gated by the shared secret checked in code.
  aws_ lambda add-permission --function-name "$FUNCTION_NAME" \
    --statement-id FunctionURLAllowPublicAccess --action lambda:InvokeFunctionUrl \
    --principal '*' --function-url-auth-type NONE >/dev/null 2>&1 || true
  ok "function URL created"
fi

FUNCTION_URL="$(aws_ lambda get-function-url-config --function-name "$FUNCTION_NAME" \
  --query FunctionUrl --output text)"
FUNCTION_HOST="$(sed -E 's#^https://##; s#/$##' <<<"$FUNCTION_URL")"
ok "origin host: $FUNCTION_HOST"

# ──────────────────────────── 7. CloudFront wiring ───────────────────────────
say "CloudFront: $PATH_PATTERN behaviour on $DISTRIBUTION_ID"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

aws cloudfront get-distribution-config --id "$DISTRIBUTION_ID" --output json > "$tmp/current.json"
etag="$(jq -r '.ETag' "$tmp/current.json")"

jq --arg oid "$ORIGIN_ID" --arg host "$FUNCTION_HOST" --arg secret "$ORIGIN_SECRET" \
   --arg header "$SECRET_HEADER" --arg pattern "$PATH_PATTERN" \
   --arg cache "$CACHE_POLICY_DISABLED" --arg orp "$ORIGIN_REQ_ALL_VIEWER_EXCEPT_HOST" '
  .DistributionConfig
  # ── origin: replace any previous entry with the same id ──
  | .Origins.Items = ((.Origins.Items | map(select(.Id != $oid))) + [{
      Id: $oid,
      DomainName: $host,
      OriginPath: "",
      CustomHeaders: { Quantity: 1, Items: [ { HeaderName: $header, HeaderValue: $secret } ] },
      CustomOriginConfig: {
        HTTPPort: 80, HTTPSPort: 443,
        OriginProtocolPolicy: "https-only",
        OriginSslProtocols: { Quantity: 1, Items: ["TLSv1.2"] },
        OriginReadTimeout: 30, OriginKeepaliveTimeout: 5
      },
      ConnectionAttempts: 3, ConnectionTimeout: 10,
      OriginShield: { Enabled: false }
    }])
  | .Origins.Quantity = (.Origins.Items | length)
  # ── behaviour: /api/* has NO CloudFront function attached, so the
  #    portament-clean-urls viewer-request rewrite (extensionless -> .html)
  #    never runs on it. Attaching it would turn /api/contact into
  #    /api/contact.html and break every submission.
  | .CacheBehaviors.Items = (((.CacheBehaviors.Items // []) | map(select(.PathPattern != $pattern))) + [{
      PathPattern: $pattern,
      TargetOriginId: $oid,
      ViewerProtocolPolicy: "https-only",
      AllowedMethods: {
        Quantity: 7,
        Items: ["GET","HEAD","OPTIONS","PUT","POST","PATCH","DELETE"],
        CachedMethods: { Quantity: 2, Items: ["GET","HEAD"] }
      },
      Compress: true,
      CachePolicyId: $cache,
      OriginRequestPolicyId: $orp,
      FunctionAssociations: { Quantity: 0 },
      LambdaFunctionAssociations: { Quantity: 0 },
      FieldLevelEncryptionId: "",
      SmoothStreaming: false
    }])
  | .CacheBehaviors.Quantity = (.CacheBehaviors.Items | length)
' "$tmp/current.json" > "$tmp/updated.json"

echo "  Planned change:"
echo "    + origin      $ORIGIN_ID -> $FUNCTION_HOST (custom header $SECRET_HEADER)"
echo "    + behaviour   $PATH_PATTERN -> $ORIGIN_ID, caching disabled, no viewer function"
echo "    default behaviour, S3 origin and clean-URL function are left untouched."

if confirm "Apply to the production distribution?"; then
  aws cloudfront update-distribution --id "$DISTRIBUTION_ID" \
    --if-match "$etag" --distribution-config "file://$tmp/updated.json" >/dev/null
  ok "distribution updated (propagation takes ~5 min)"
  aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" \
    --paths '/api/*' >/dev/null
  ok "invalidation created"
else
  warn "CloudFront step skipped — /api/contact will 404 until it is applied"
  cp "$tmp/updated.json" "$SCRIPT_DIR/.cloudfront-planned.json"
  warn "planned config saved to backend/.cloudfront-planned.json"
fi

# ────────────────────────────────── summary ──────────────────────────────────
say "Done"
cat <<EOF
  Function      $FUNCTION_NAME ($REGION)
  Function URL  $FUNCTION_URL
  Endpoint      https://$DOMAIN/api/contact
  From          $SENDER_EMAIL
  To            $RECIPIENT_EMAIL

  Smoke test (after propagation):
    curl -i https://$DOMAIN/api/contact \\
      -H 'content-type: application/json' \\
      -d '{"name":"テスト","email":"you@example.com","company":"テスト","message":"疎通確認","page":"/curl"}'

  Expect: HTTP 200 {"ok":true} and mail in $RECIPIENT_EMAIL.
EOF
