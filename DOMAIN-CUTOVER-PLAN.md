# Plan — Attach `portament.jp` to the AWS landing page (Route 53 cutover)

## Context

The portament landing page is now **live on AWS** at `https://d1b712r5es4lvf.cloudfront.net`
(S3 `portament-lps` → CloudFront `E86W76PW0HMG8`, OAC-locked, free CloudFront cert). It was
deployed **without a custom domain** deliberately, so building it carried zero risk to the
existing live site/email.

Goal now: make **`portament.jp`** (apex) and **`www.portament.jp`** serve this AWS site, while
**company email keeps flowing to Google Workspace** uninterrupted.

Today `portament.jp` DNS is hosted at **Wix** (`ns0/ns1.wixdns.net`). Email is **Google
Workspace** (MX → `aspmx.l.google.com`), not Wix — Wix only hosts the DNS records. The apex
**cannot** point to CloudFront from Wix (no apex-alias support), so we move DNS authority to
**Route 53**, re-create every existing record (critically the Google MX), add apex+www aliases
to CloudFront, **verify the new zone answers correctly before going live**, then flip the
nameservers. This is fully reversible (switch nameservers back to Wix).

## Key facts / identifiers

| Item | Value |
|---|---|
| AWS profile | `opsguide` (account `396115588530`, user `indonesia-dev`) |
| S3 bucket | `portament-lps` (us-east-1), site under prefix `/hpreconstruction` |
| CloudFront distribution | `E86W76PW0HMG8` → `d1b712r5es4lvf.cloudfront.net` |
| CloudFront alias hosted-zone (constant) | `Z2FDTNDATAQYW2` |
| Existing unused `lp` cert (delete later) | `arn:aws:acm:us-east-1:396115588530:certificate/5bd11796-30b2-4a57-88ad-c92affa7c893` |

### Existing DNS inventory to preserve (from Wix panel + live lookup)
- **MX** (Google Workspace): `10 aspmx.l.google.com.`, `20 alt1.aspmx.l.google.com.`, `30 alt2.aspmx.l.google.com.`, `40 alt3.aspmx.l.google.com.`, `50 alt4.aspmx.l.google.com.`
- **TXT** `portament.jp`:
  - `"zoom-domain-verification=ZOOM_verify_d4659c540ebf46c5b1a889b57970450d"`
  - `"google-site-verification=sMrujo8umz6ITgHOQr6-q-M02Wj5pjLaQn7pvi1FU-w"`
  - `"google-site-verification=eskj7iqcza0woz_vtlz7cxwnmaii-mfa3jbvch41wam"`
- No SPF, DKIM, DMARC, SRV, or extra subdomains (pre-existing state — not changed here).

## Who does what
- **I (CLI, profile `opsguide`)**: ACM request, CloudFront update, Route 53 zone + records, all verification, cleanup.
- **You (manually in Wix)**: (1) add the ACM validation CNAME(s) so the cert can issue while Wix is still authoritative; (2) the **nameserver flip** at the end. Both: *Wix → Domains → portament.jp*.

---

## Steps

### Step A — Request the apex+www SSL certificate (ACM, us-east-1)
```bash
AWS_PROFILE=opsguide aws acm request-certificate --region us-east-1 \
  --domain-name portament.jp \
  --subject-alternative-names www.portament.jp \
  --validation-method DNS \
  --query CertificateArn --output text
```
Then read the validation CNAME(s):
```bash
AWS_PROFILE=opsguide aws acm describe-certificate --region us-east-1 \
  --certificate-arn <NEW_ARN> \
  --query "Certificate.DomainValidationOptions[].ResourceRecord"
```
**You add the returned CNAME(s) in Wix** (DNS Records → CNAME → Add). The cert goes `ISSUED`
once they propagate. *(These validation CNAMEs are also added to the Route 53 zone in Step C
so auto-renewal keeps working after the flip.)*

### Step B — Attach the domain to the existing CloudFront distribution
Update **the same** distribution `E86W76PW0HMG8` (no rebuild): add
`Aliases = [portament.jp, www.portament.jp]` and switch `ViewerCertificate` from the default
cert to the new ACM ARN (via `get-distribution-config` → edit → `update-distribution` with the
current ETag). Distribution redeploys (~5–15 min). The `cloudfront.net` URL keeps working.

### Step C — Create & populate the Route 53 hosted zone (NOT live yet)
```bash
AWS_PROFILE=opsguide aws route53 create-hosted-zone \
  --name portament.jp --caller-reference portament-cutover-1
# note the 4 assigned NS (ns-xxx.awsdns-xx ...)
```
Create one `change-batch` with all records:
- **MX** — the 5 Google records above (copied verbatim)
- **TXT** `portament.jp` — the 3 values above (one record set, multiple values)
- **CNAME** — the ACM validation record(s) from Step A (for future renewals)
- **A (alias)** `portament.jp` → `d1b712r5es4lvf.cloudfront.net` (HostedZoneId `Z2FDTNDATAQYW2`)
- **AAAA (alias)** `portament.jp` → same
- **A (alias)** `www.portament.jp` → same
- **AAAA (alias)** `www.portament.jp` → same

*(NS + SOA auto-created — leave them.)*

### Step D — Verify the new zone BEFORE flipping (the safety gate)
Query the Route 53 nameservers directly while the public internet still uses Wix:
```bash
NS=ns-xxx.awsdns-xx.com   # one of the 4 from Step C
dig MX  portament.jp        @$NS +short   # MUST return the 5 Google MX
dig A   portament.jp        @$NS +short   # MUST resolve to CloudFront
dig A   www.portament.jp    @$NS +short   # MUST resolve to CloudFront
dig TXT portament.jp        @$NS +short   # MUST show zoom + 2 google verifications
```
**Do not proceed unless MX returns the Google records.** This proves email survives the flip.

### Step E — Flip the nameservers (the cutover — you, in Wix)
*Wix → Domains → portament.jp → Advanced → Name Servers* → switch to **custom/external** →
replace `ns0/ns1.wixdns.net` with the **4 Route 53 nameservers** from Step C → Save.
Wix warns it disconnects the Wix site — that is expected and correct.

### Step F — Verify live, then clean up
```bash
dig NS portament.jp +short                 # should return the 4 Route 53 NS
curl -I https://portament.jp               # 200 from CloudFront
curl -I https://www.portament.jp           # 200
curl -I http://portament.jp                # 301 -> https
```
- **Send + receive a real test email** to/from `@portament.jp` (confirms Google Workspace intact).
- After stable (a day or two): delete the unused `lp` cert; cancel/retire the Wix plan.

## Rollback
At any point before/after the flip: in Wix set the nameservers **back** to
`ns0.wixdns.net` / `ns1.wixdns.net`. After propagation, everything returns to Wix. Keep the
Wix site intact until Step F passes.

## Risk notes
- **Email** is the main risk; it is gated by Step D (prove MX before flip) + the post-flip mail test.
- Apex is the reason for Route 53 (Wix can't alias the apex to CloudFront).
- TTLs on the Wix records are 1h, so propagation/rollback is reasonably fast; optionally lower
  to 300s ~24h before the flip for an even faster rollback window.

## Verification summary
End-to-end success = all true: cert `ISSUED`; distribution `Deployed` with both aliases;
`dig @route53-ns` returns Google MX + CloudFront A/AAAA **before** flip; after flip
`https://portament.jp` and `https://www.portament.jp` return 200, HTTP→301; **test email sends
and receives** on `@portament.jp`.
