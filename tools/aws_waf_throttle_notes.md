# Aarvex API Gateway throttle + AWS WAF (ops notes)

Deploy these in AWS Console / Terraform / CDK. Lambda code already fail-closes
sensitive write rate limits (`feed_post`, `chat_send`, `story_create`, `feed_comment`).

## API Gateway (HTTP API or REST)

1. Create a **Usage Plan** on the portal stage:
   - Rate: 50 req/s (steady)
   - Burst: 100
2. Optionally attach API keys for partner bots only (portal users use Google JWT).
3. Enable **Throttling** per route for:
   - `POST /feed/post`
   - `POST /chat/send`
   - `POST /story/create`
   - `POST /kyc/submit`
   - `POST /order` (or your order create path)

## AWS WAF (CloudFront + API)

Attach a Web ACL to CloudFront distribution serving `aarvexglobal.com` and to the API stage:

Managed rule groups (start here):

- `AWSManagedRulesCommonRuleSet`
- `AWSManagedRulesKnownBadInputsRuleSet`
- `AWSManagedRulesAmazonIpReputationList`
- `AWSManagedRulesAnonymousIpList` (review false positives for mobile CGNAT)

Custom rules:

- Block request bodies > 7 MB (base64 uploads should move to presigned S3).
- Rate-based rule: 2000 requests / 5 min / IP on `/feed/post` and `/chat/send`.

## Content-Security-Policy (CloudFront response headers policy)

```
default-src 'self';
script-src 'self' https://cdnjs.cloudflare.com https://challenges.cloudflare.com https://accounts.google.com;
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com;
img-src 'self' data: blob: https://*.cloudfront.net https://*.googleusercontent.com;
connect-src 'self' https://*.execute-api.*.amazonaws.com https://accounts.google.com;
frame-src https://challenges.cloudflare.com https://accounts.google.com;
```

Tune after testing Turnstile + Google Sign-In.

## IAM (Lambda)

Least privilege sketch:

- DynamoDB: GetItem/PutItem/UpdateItem/DeleteItem/Query on table + GSI only
- S3: PutObject/GetObject/DeleteObject/ListBucket on invoice/media bucket prefixes
- Rekognition: `DetectModerationLabels` only (when auto-moderation media scan enabled)
- No `*` on `s3:*` or `dynamodb:*`

## Deploy checklist

1. Upload `content_moderation.py`, `admin_session.py`, `design_auditor.py` with Lambda package (same zip as `marketplace.py`).
2. Confirm DynamoDB TTL attribute `ttl` enabled on table (covers `ADMINSESS#`, lockout, design audits).
3. Admin → Settings → enable Auto-detect, optional keyword pack; verify a test blocked keyword.
4. Attach CSP response headers policy (snippet above) to CloudFront when ready.
5. Bump `sw.js` `SW_VERSION` on each static deploy.
6. Design Auditor: Admin → Design Studio → Run; optional Playwright PNGs via `tools/design_auditor/capture.mjs`.
