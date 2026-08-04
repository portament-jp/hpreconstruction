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
- **Custom origin request policy `portament-contact-viewer-address`**, not the managed
  `AllViewerExceptHostHeader`. See "Visitor IP" below.

## Visitor IP

Getting the real visitor address right is fiddlier than it looks, and the first two
attempts were both wrong:

- `requestContext.http.sourceIp` is the **CloudFront edge**, not the visitor.
- The first entry of `X-Forwarded-For` is **attacker-controlled**. CloudFront *appends*
  the real viewer address to whatever chain the client sent, so a request with
  `X-Forwarded-For: 203.0.113.99` arrives as `203.0.113.99, <real viewer>`. Taking `[0]`
  reports whatever the sender made up. Counting from the end is not safe to guess either,
  since the function URL layer may append as well.

So the handler prefers **`CloudFront-Viewer-Address`**, which CloudFront sets itself and
the viewer cannot influence. It carries a trailing `:port` (on IPv6 too, after the *last*
colon) which is stripped. If that header is absent, the handler falls back to printing the
**entire `X-Forwarded-For` chain**, labelled as spoofable, rather than presenting one entry
as fact. Last resort is the edge IP.

`CloudFront-Viewer-Address` only arrives if the origin request policy forwards it. The
managed `AllViewerExceptHostHeader` does not include it, and the managed policies that do
also forward `Host`, which makes a Lambda function URL return 403. Hence the custom
whitelist policy, which the deploy script creates and reuses by name.

The `sent` log line includes `ipTrusted` — `true` means the header arrived and the IP is
the reliable one, `false` means it fell back. That is the quickest way to confirm the
policy is attached.

**This value is informational only and is never an input to an auth or trust decision.**

## Files

| Path | Purpose |
|---|---|
| `contact/index.mjs` | Lambda handler — HTTP concerns, secret check, SES send |
| `contact/validate.mjs` | Pure validation + email building (no AWS imports) |
| `contact/test.mjs` | Unit tests — `node backend/contact/test.mjs` |
| `deploy-contact-backend.sh` | Idempotent deploy of every piece above |

## Deploying

> **The `opsguide` profile cannot run this.** It has ReadOnly + S3/CloudFront/Route53/ACM
> only — `lambda:CreateFunction`, `iam:CreateRole`, `iam:PassRole` and
> `ses:CreateEmailIdentity` are all implicit-deny. The script checks this up front and
> warns. Use credentials with those permissions on account `396115588530`; the
> `opsguide-dev` profile is **not** a substitute (different account, `654654574429`).

### Getting the permissions

`deploy-permissions-policy.json` in this directory is the **minimum delta** needed on top
of what `indonesia-dev` already has — its existing `AmazonRoute53FullAccess` and
`CloudFrontFullAccess` already cover the DNS and distribution steps, so the policy only
adds SES, IAM, Lambda and Logs, each scoped to the exact resources the script creates
(the `portament.jp` identity, the one role, the one function, its log group). It does not
grant general admin.

Whoever holds admin on `396115588530` can either run the script themselves, or attach it:

```bash
aws iam create-policy --policy-name portament-contact-form-deploy \
  --policy-document file://backend/deploy-permissions-policy.json
aws iam attach-user-policy --user-name indonesia-dev \
  --policy-arn arn:aws:iam::396115588530:policy/portament-contact-form-deploy
```

After the deploy succeeds the policy can be detached again — it is only needed to create
the resources, not to run them.

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

```bash
# 1. backend first
AWS_PROFILE=<admin> ./backend/deploy-contact-backend.sh
# 2. verify with the curl smoke test the script prints
# 3. only then the pages
AWS_PROFILE=opsguide aws s3 cp index.html s3://portament-lps/hpreconstruction/index.html
#   … and the other four pages, then invalidate
AWS_PROFILE=opsguide aws cloudfront create-invalidation --distribution-id E86W76PW0HMG8 \
  --paths '/index.html' '/agentmaker.html' '/wavelopment.html' '/agentpartner.html' '/allrounder.html'
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
