# Contact form backend

Delivers submissions from the お問い合わせ form on all five pages to **sales@portament.jp**.

Before this existed, every form on the site called `preventDefault()` and showed the
success message without sending anything. Submissions made between the June 2026 Wix
cutover and this deploy were never captured anywhere and cannot be recovered.

## Architecture

```
browser  ──POST /api/contact──▶  CloudFront E86W76PW0HMG8
                                   │  behaviour /api/*  (caching disabled,
                                   │  AllViewerExceptHostHeader, NO viewer function)
                                   │  adds header x-portament-origin: <secret>
                                   ▼
                                 Lambda function URL  (portament-contact-form, us-east-1)
                                   │  validates, rejects spam, checks the secret
                                   ▼
                                 SES  ──▶  sales@portament.jp   (Reply-To: the inquirer)
```

Why it is shaped this way:

- **Same-origin `/api/contact`** rather than calling the `*.lambda-url.on.aws` host
  directly. No CORS preflight, no volatile hostname baked into five HTML files, and
  the backend is not separately addressable in the page source.
- **The `/api/*` behaviour has no CloudFront function attached.** The default behaviour
  runs `portament-clean-urls`, which rewrites extensionless paths to `.html`. If that
  function ran on this path, `/api/contact` would become `/api/contact.html` and every
  submission would fail. Do not attach it.
- **Shared secret header.** The function URL is `AuthType: NONE` and therefore publicly
  reachable. CloudFront injects `x-portament-origin`; the handler rejects anything
  without it, so the raw URL is not an open relay.
- **us-east-1.** SES already has production access there (50,000/day). ap-northeast-1
  is still in the sandbox and would need a support request.

## Files

| Path | Purpose |
|---|---|
| `contact/index.mjs` | Lambda handler — HTTP concerns, secret check, SES send |
| `contact/validate.mjs` | Pure validation + email building (no AWS imports) |
| `contact/test.mjs` | Unit tests — `node backend/contact/test.mjs` |
| `deploy-contact-backend.sh` | Idempotent deploy of every piece above |

## Deploying

The `opsguide` profile **can** run this — it has `lambda:*`, `iam:*` (scoped to this
role) and `ses:*` on account `396115588530` in addition to the
S3/CloudFront/Route53/ACM access documented elsewhere. (An earlier version of this
doc claimed the opposite; that was wrong.) The `opsguide-dev` profile is still **not**
a substitute — different account, `654654574429`.

### CI (GitHub Actions) — the normal path

Every push to `main` runs `.github/workflows/deploy.yml`, which deploys the backend and
then the static site automatically. It authenticates via GitHub OIDC to the
purpose-built role `arn:aws:iam::396115588530:role/portament-lp-deploy-github` — no
long-lived AWS keys are stored in the repo. To trigger a deploy without pushing new
commits (e.g. to retry after an unrelated CI failure), run the workflow manually from
the **Actions** tab (`workflow_dispatch`).

### Manual / local deploys

`indonesia-dev` has a customer-managed IAM policy, `PortamentLPContactFormDeploy`
(same content as `deploy-permissions-policy.json` in this directory), attached
directly — the local deploy scripts can be run from that user's own credentials
without borrowing anyone else's. Route 53 / CloudFront / S3 permissions are **not**
part of that policy because `indonesia-dev` already held `AmazonRoute53FullAccess`
and `CloudFrontFullAccess` (and S3 access) beforehand; the added policy only covers
SES, IAM, Lambda and Logs, each scoped to the exact resources the script creates (the
`portament.jp` identity, the one role, the one function, its log group). It does not
grant general admin.

**Known constraint:** `ses:CreateEmailIdentity` does not support resource-level
restriction — a policy that scopes it to the `portament.jp` identity ARN will still
get denied by AWS for that action specifically. In practice this rarely matters: the
`portament.jp` SES identity already exists and the script skips creation when it's
already there (see step 1 below). It only becomes a problem if the identity needs to
be recreated from scratch, which needs broader (admin) SES permissions.

```bash
node backend/contact/test.mjs                    # unit tests first
AWS_PROFILE=<admin> ./backend/deploy-contact-backend.sh
```

The script will:

1. Create the SES domain identity for `portament.jp` and publish three Easy DKIM
   CNAMEs to Route 53, then wait for verification. **The apex MX (Google Workspace)
   and existing TXT records are not touched.**
2. Create `portament-contact-form-role` with logs access and an `ses:SendEmail` policy
   scoped to the domain identity and conditioned on `ses:FromAddress`.
3. Bundle and deploy the `portament-contact-form` function (nodejs22.x). The AWS SDK is
   vendored into the zip rather than relying on the runtime's bundled copy.
4. Create the function URL and generate the origin secret into `backend/.origin-secret`
   (gitignored — keep it; it is recoverable from the function's env vars if lost).
5. Show the planned CloudFront change and **prompt before applying it**. Pass `--yes`
   to skip the prompt, or decline to have the planned config written to
   `backend/.cloudfront-planned.json` for review.

Override the addresses with `RECIPIENT_EMAIL=` / `SENDER_EMAIL=` env vars.

## Deploy order matters

The HTML changes and the backend must go live together, and the backend should go first.
The pages now surface a visible error when `/api/contact` fails instead of silently
showing the success message, so **uploading the HTML before the backend exists replaces a
fake success with a real error on the live site.**

`deploy-contact-backend.sh` in this directory only ever touches the backend (Lambda,
IAM, SES, the CloudFront `/api/*` behaviour). It never uploads HTML. The static pages
are the responsibility of `deploy-site.sh` in the repo root — see its own `--dry-run`
output for exactly what it uploads and invalidates. The CI workflow already runs them
in the correct order; if deploying by hand, do the same:

```bash
# 1. backend first
AWS_PROFILE=<admin> ./backend/deploy-contact-backend.sh --yes
# 2. verify with the curl smoke test the script prints
# 3. only then the static pages
AWS_PROFILE=<admin> ./deploy-site.sh
```

## Verifying

```bash
curl -i https://portament.jp/api/contact \
  -H 'content-type: application/json' \
  -d '{"name":"テスト","email":"you@example.com","company":"テスト","message":"疎通確認","page":"/curl"}'
```

Expect `200 {"ok":true}` and mail in `sales@portament.jp` with `Reply-To` set to the
address in the payload. Then submit the real form in a browser on one page.

Logs: `aws logs tail /aws/lambda/portament-contact-form --follow --region us-east-1`
(retention 90 days). Events are one JSON object per line: `sent`, `honeypot`,
`origin_rejected`, `ses_failed`, `misconfigured`.

## Spam handling

A hidden `website` input is added to each form. Bots fill it; browsers leave it empty.
When it is non-empty the handler logs `honeypot` and returns `200 {"ok":true}` without
sending, so the bot gets no signal that it was caught. Length caps and a control-character
guard (header injection) are enforced server-side regardless of what the browser allowed.

If volume becomes a problem, the next step is AWS WAF with a rate-based rule on the
`/api/*` behaviour — no code change needed.

## Known gaps / follow-ups

- **No SPF or DMARC record exists for `portament.jp`.** The apex has Google Workspace MX
  records and Zoom/Google verification TXT records, but no `v=spf1` and no `_dmarc`.
  DKIM alone (added by this deploy) gives SES-sent mail a valid signature, but adding
  SPF and DMARC would materially improve deliverability for *all* company mail. This was
  deliberately left out of the script because it affects Google Workspace delivery too
  and is a decision for whoever owns company email, not a side effect of a form deploy.
  Suggested, once someone owns it:
  `v=spf1 include:_spf.google.com include:amazonses.com ~all`
- **No auto-reply to the person who submitted.** The form already promises a human reply
  within two business days, so this is not required. SES production access in us-east-1
  means it can be added whenever wanted.
- **No custom MAIL FROM domain**, so bounces use `amazonses.com`. Adding one needs an MX
  record on a subdomain; harmless to the apex, but not needed for this volume.
- **No persistence.** Submissions exist only as email. If a delivery fails the sender sees
  an error and is asked to mail `sales@portament.jp` directly. Adding DynamoDB or an S3
  write is straightforward if a record is wanted.
