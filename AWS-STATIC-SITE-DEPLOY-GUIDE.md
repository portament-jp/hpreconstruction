# Panduan Deploy Static Landing Page ke AWS (S3 + CloudFront + ACM + Route 53)

Panduan ini mendokumentasikan mekanisme deploy static site (HTML/CSS/JS + gambar)
ke AWS dengan HTTPS dan custom domain — sesuai cara yang dipakai untuk
`venture.bizinnovator.ai`. Cocok untuk landing page statis tanpa backend.

---

## Arsitektur

```
Pengunjung
   │  https://domain-kamu.com
   ▼
[ Route 53 ]  (DNS: alias A/AAAA → CloudFront)
   │
   ▼
[ CloudFront ]  (CDN + HTTPS via ACM cert + cache di edge)
   │  (akses private via OAC / Origin Access Control)
   ▼
[ S3 Bucket ]  (private, simpan file HTML/gambar — TIDAK public)
```

**Kenapa pakai pola ini:**
- **S3** = penyimpanan file murah, tapi bucket-nya **private** (lebih aman).
- **CloudFront** = CDN global → cepat + kasih HTTPS + cache.
- **OAC (Origin Access Control)** = hanya CloudFront yang boleh baca S3, publik tidak bisa akses bucket langsung.
- **ACM** = SSL certificate gratis untuk HTTPS.
- **Route 53** = DNS, arahkan domain ke CloudFront.

---

## Prasyarat

1. **AWS account** + user IAM dengan akses ke: S3, CloudFront, ACM, Route 53.
   Policy AWS-managed yang dipakai dulu:
   - `AmazonS3FullAccess`
   - `CloudFrontFullAccess`
   - `AWSCertificateManagerFullAccess`
   - `AmazonRoute53FullAccess`
   - `ReadOnlyAccess` (opsional, untuk lihat-lihat)
2. **AWS CLI** sudah terinstall & terkonfigurasi (`aws configure` atau pakai profile).
3. **Domain sudah ada hosted zone-nya di Route 53.** Kalau domain beli di luar
   (mis. Onamae/GoDaddy), arahkan NS-nya ke Route 53 dulu, atau kelola DNS di registrar.

> **Catatan variabel** — ganti nilai di bawah ini dengan punyamu:
> ```
> DOMAIN          = sub.domain-kamu.com        (mis. venture.bizinnovator.ai)
> BUCKET          = nama-bucket-unik            (mis. venture-bizinnovator-ai-lp)
> ACCOUNT_ID      = 123456789012
> REGION_S3       = us-east-1                   (bebas, tapi catat regionnya)
> HOSTED_ZONE_ID  = ZXXXXXXXXXXXX               (hosted zone Route 53 domainmu)
> ```

---

## Step 1 — Buat S3 Bucket (private)

**Console:** S3 → Create bucket
- Bucket name: `BUCKET` (harus unik global)
- Region: `REGION_S3`
- **Block all public access: BIARKAN AKTIF (semua tercentang)** ← penting, biar private
- Bucket Versioning: Enable (opsional, biar bisa rollback)
- Default encryption: SSE-S3 (default, biarkan)
- Create bucket

**CLI:**
```bash
aws s3api create-bucket --bucket BUCKET --region us-east-1
# (kalau region selain us-east-1, tambah --create-bucket-configuration LocationConstraint=REGION_S3)

aws s3api put-public-access-block --bucket BUCKET \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

---

## Step 2 — Upload file landing page

**Console:** buka bucket → Upload → drag semua file (`index.html`, gambar, dll) → Upload.

> S3 otomatis deteksi Content-Type dari ekstensi (`.html` → `text/html`).
> Untuk file tanpa ekstensi (mis. clean URL `contact`), set Content-Type manual ke `text/html`.

**CLI (upload satu folder sekaligus):**
```bash
aws s3 sync ./ s3://BUCKET/ \
  --exclude ".git/*" --exclude "*.md" \
  --cache-control "public, max-age=300"
```

---

## Step 3 — Request SSL Certificate (ACM)

> **PENTING: certificate untuk CloudFront WAJIB dibuat di region `us-east-1` (N. Virginia)**,
> apapun region bucket-mu. Kalau salah region, nanti tidak muncul di CloudFront.

**Console:** ACM (region **us-east-1**) → Request certificate → Request a public certificate
- Domain name: `DOMAIN`
- Validation method: **DNS validation** (rekomendasi)
- Request

Lalu di halaman certificate → klik **"Create records in Route 53"** (tombol otomatis bikin
CNAME validation record). Tunggu beberapa menit → status berubah jadi **Issued**.

**CLI:**
```bash
aws acm request-certificate --region us-east-1 \
  --domain-name DOMAIN \
  --validation-method DNS \
  --query CertificateArn --output text
# Catat ARN-nya. Lalu ambil CNAME validasi:
aws acm describe-certificate --region us-east-1 --certificate-arn <ARN> \
  --query "Certificate.DomainValidationOptions[0].ResourceRecord"
# Tambahkan CNAME itu ke Route 53 (atau pakai tombol Console di atas).
```

---

## Step 4 — Buat CloudFront Distribution + OAC

> ⚠️ **Gotcha:** UI CloudFront baru ada wizard "Choose a plan" (Free/Pro/Business) yang
> maksa bikin S3 & DNS sendiri — **TIDAK cocok** kalau bucket & domain sudah ada.
> Lebih mulus lewat **CLI**. (Ini yang kita pilih dulu.)

### 4a. Buat Origin Access Control (OAC)
```bash
aws cloudfront create-origin-access-control \
  --origin-access-control-config \
  Name=BUCKET-oac,SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3 \
  --query "OriginAccessControl.Id" --output text
# Catat OAC ID (mis. EXXXXXXXXXX)
```

### 4b. Buat file config distribution `cloudfront-distribution.json`
Ganti: `BUCKET`, `REGION_S3`, `DOMAIN`, `OAC_ID`, `ACM_ARN`.
```json
{
  "CallerReference": "BUCKET-2026-01-01",
  "Aliases": { "Quantity": 1, "Items": ["DOMAIN"] },
  "DefaultRootObject": "index.html",
  "Comment": "Landing page DOMAIN",
  "Enabled": true,
  "Origins": {
    "Quantity": 1,
    "Items": [{
      "Id": "S3-BUCKET",
      "DomainName": "BUCKET.s3.REGION_S3.amazonaws.com",
      "S3OriginConfig": { "OriginAccessIdentity": "" },
      "OriginAccessControlId": "OAC_ID",
      "ConnectionAttempts": 3, "ConnectionTimeout": 10,
      "CustomHeaders": { "Quantity": 0 },
      "OriginShield": { "Enabled": false }
    }]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "S3-BUCKET",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"],
      "CachedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] } },
    "Compress": true,
    "CachePolicyId": "658327ea-f89d-4fab-a63d-7e88639e58f6",
    "SmoothStreaming": false, "FieldLevelEncryptionId": "",
    "LambdaFunctionAssociations": { "Quantity": 0 },
    "FunctionAssociations": { "Quantity": 0 },
    "TrustedSigners": { "Enabled": false, "Quantity": 0 },
    "TrustedKeyGroups": { "Enabled": false, "Quantity": 0 }
  },
  "CacheBehaviors": { "Quantity": 0 },
  "CustomErrorResponses": { "Quantity": 0 },
  "Logging": { "Enabled": false, "IncludeCookies": false, "Bucket": "", "Prefix": "" },
  "PriceClass": "PriceClass_200",
  "ViewerCertificate": {
    "ACMCertificateArn": "ACM_ARN",
    "SSLSupportMethod": "sni-only",
    "MinimumProtocolVersion": "TLSv1.2_2021",
    "Certificate": "ACM_ARN",
    "CertificateSource": "acm"
  },
  "Restrictions": { "GeoRestriction": { "RestrictionType": "none", "Quantity": 0 } },
  "WebACLId": "", "HttpVersion": "http2and3", "IsIPV6Enabled": true, "Staging": false
}
```
> Catatan: `CachePolicyId` `658327ea-...` = managed policy **CachingOptimized** (bawaan AWS).
> `CallerReference` harus unik tiap kali create (pakai tanggal/timestamp).

### 4c. Create distribution
```bash
aws cloudfront create-distribution \
  --distribution-config file://cloudfront-distribution.json \
  --query "Distribution.{Id:Id,Domain:DomainName,Status:Status}"
# Catat: Distribution Id (mis. EXXXXXXXXX) & DomainName (mis. dxxxx.cloudfront.net)
```
Tunggu status `Deploying` → `Deployed` (biasanya < 10 menit).

---

## Step 5 — Pasang S3 Bucket Policy (izinkan OAC baca)

Setelah distribution jadi, izinkan CloudFront (via service principal) baca bucket.
Buat `s3-bucket-policy.json` — ganti `BUCKET`, `ACCOUNT_ID`, `DISTRIBUTION_ID`:
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowCloudFrontServicePrincipalReadOnly",
    "Effect": "Allow",
    "Principal": { "Service": "cloudfront.amazonaws.com" },
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::BUCKET/*",
    "Condition": {
      "StringEquals": {
        "AWS:SourceArn": "arn:aws:cloudfront::ACCOUNT_ID:distribution/DISTRIBUTION_ID"
      }
    }
  }]
}
```
```bash
aws s3api put-bucket-policy --bucket BUCKET --policy file://s3-bucket-policy.json
```

---

## Step 6 — Arahkan domain via Route 53 (alias ke CloudFront)

Buat record **A** dan **AAAA** (IPv6) sebagai alias ke domain CloudFront.
Buat `route53-records.json` — ganti `DOMAIN` & `dxxxx.cloudfront.net`:
```json
{
  "Comment": "Alias DOMAIN ke CloudFront",
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "DOMAIN", "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "Z2FDTNDATAQYW2",
          "DNSName": "dxxxx.cloudfront.net",
          "EvaluateTargetHealth": false
        }
      }
    },
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "DOMAIN", "Type": "AAAA",
        "AliasTarget": {
          "HostedZoneId": "Z2FDTNDATAQYW2",
          "DNSName": "dxxxx.cloudfront.net",
          "EvaluateTargetHealth": false
        }
      }
    }
  ]
}
```
> `Z2FDTNDATAQYW2` = **konstanta** hosted zone ID untuk SEMUA alias CloudFront (jangan diganti).
```bash
aws route53 change-resource-record-sets \
  --hosted-zone-id HOSTED_ZONE_ID \
  --change-batch file://route53-records.json
# Tunggu sampai status INSYNC (cek dengan get-change pakai Id yang dikembalikan)
```

---

## Step 7 — Verifikasi

```bash
# Cek HTTPS 200 OK
curl -I https://DOMAIN

# Cek redirect HTTP → HTTPS (harus 301)
curl -I http://DOMAIN

# Cek cert valid + TLS
curl -vI https://DOMAIN 2>&1 | grep -i "SSL\|subject\|HTTP/"
```
Lalu buka `https://DOMAIN` di browser, hard reload (Ctrl+Shift+R), cek semua gambar/asset kebuka.

---

## Update Konten (deploy ulang)

Setiap kali ada perubahan file:
```bash
# 1. Upload file yang berubah ke S3
aws s3 cp index.html s3://BUCKET/index.html \
  --content-type "text/html; charset=utf-8" --cache-control "public, max-age=300"
# (atau: aws s3 sync ./ s3://BUCKET/ untuk banyak file)

# 2. Invalidate cache CloudFront biar edge ambil versi baru
aws cloudfront create-invalidation \
  --distribution-id DISTRIBUTION_ID \
  --paths "/index.html" "/"
# Tunggu status Completed (~1-3 menit), lalu hard reload browser.
```
> Invalidation gratis untuk 1000 path pertama / bulan. `/*` invalidate semua (boros, hindari kalau bisa).

---

## Estimasi Biaya

Untuk satu landing page traffic kecil-menengah, hampir semuanya masuk **free tier** /
beberapa sen per bulan:
- S3: storage beberapa MB + request → murah banget
- CloudFront: 1 TB transfer/bulan gratis (free tier baru), request murah
- ACM: **gratis**
- Route 53: ~$0.50/bulan per hosted zone + query murah

`PriceClass_200` (dipakai di config) = exclude edge location paling mahal (Amerika Selatan,
Oceania) buat hemat. Bisa diganti `PriceClass_All` kalau butuh coverage global penuh.

---

## Checklist Ringkas

- [ ] S3 bucket dibuat, **private** (block public access ON)
- [ ] File ter-upload, Content-Type benar
- [ ] ACM cert di **us-east-1**, status **Issued**
- [ ] OAC dibuat
- [ ] CloudFront distribution dibuat (pakai OAC + ACM cert), status **Deployed**
- [ ] S3 bucket policy dipasang (izinkan service principal CloudFront + SourceArn)
- [ ] Route 53 A + AAAA alias → CloudFront, status **INSYNC**
- [ ] `curl -I https://DOMAIN` → 200 OK, HTTP → 301 ke HTTPS
- [ ] Browser test + hard reload, semua asset OK

---

*Dibuat sebagai referensi internal. Sesuaikan nilai variabel dengan project masing-masing.*
