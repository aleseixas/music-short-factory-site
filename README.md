# Além do Hit — Music Short Factory creator workflow

Além do Hit is a focused web tool for creators producing short-form educational and documentary music stories. **Music Short Factory** names the broader editorial workflow. The current web application accepts a creator-finished video, connects a creator-owned TikTok account, previews the selected file locally, requires explicit confirmation, and lets the creator either send the video as a draft or publish it directly using the settings TikTok returns for that account. It does not create or edit video in the browser.

The implementation is intentionally small. It exists to demonstrate a truthful, end-to-end TikTok Sandbox flow without payments, plans, teams, analytics, an administrative dashboard, or unrelated product features.

## TikTok publishing flows

This project supports both publishing modes exposed by TikTok's Content Posting API.

- Product access: Login Kit and Content Posting API.
- Scopes: `user.info.basic`, `video.upload`, and `video.publish`.
- **Send as draft:** a creator-confirmed video is delivered to the authorized account through `video.upload`; the creator completes the post inside TikTok.
- **Publish directly:** the tool calls `creator_info/query`, shows only the privacy and interaction options currently returned for the authorized account, collects the required confirmations and disclosures, and sends the creator-confirmed post through `video.publish`.
- Both modes use the same secure OAuth connection, temporary media transfer, `publish_id`, and status workflow.

Direct Post remains subject to TikTok's audit and account restrictions. In an unaudited client, target accounts must be private, available privacy is restricted to `SELF_ONLY`, content remains private, and TikTok applies additional user and posting caps.

Official references checked on August 30, 2026:

- [TikTok App Review Guidelines](https://developers.tiktok.com/docs/en/app-review-guidelines)
- [Login Kit for Web](https://developers.tiktok.com/doc/login-kit-web)
- [Get Started — Upload](https://developers.tiktok.com/docs/en/content-posting-api-get-started-upload-content)
- [Upload API reference](https://developers.tiktok.com/docs/en/content-posting-api-reference-upload-video)
- [Direct Post API reference](https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post)
- [Query Creator Info](https://developers.tiktok.com/docs/en/content-posting-api-reference-query-creator-info)
- [Content Sharing Guidelines](https://developers.tiktok.com/docs/en/content-sharing-guidelines)
- [Get Post Status](https://developers.tiktok.com/docs/en/content-posting-api-reference-get-video-status)
- [Development configuration, trusted domains, and URL verification](https://developers.tiktok.com/docs/en/set-up-development-configuration)
- [Sandbox setup](https://developers.tiktok.com/doc/add-a-sandbox/)

## Architecture

```text
Creator browser
  ├─ public pages and app.html
  ├─ local video preview
  └─ publishing mode, account-specific settings, and explicit confirmation
          │ HTTPS, same origin
          ▼
Minimal Node/Express backend
  ├─ opaque essential session cookie + CSRF protection
  ├─ OAuth state and callback validation
  ├─ encrypted TikTok tokens in PostgreSQL
  ├─ temporary video validation and transfer
  └─ TikTok publishing status
          │
          ▼
TikTok Login Kit + Content Posting API
  ├─ creator finishes a draft in TikTok
  └─ or TikTok processes a creator-confirmed Direct Post
```

Production uses PostgreSQL whenever `DATABASE_URL` is configured. SQLite remains
the zero-setup local development store and is not allowed when
`NODE_ENV=production`.

The backend must serve the frontend and API from the same HTTPS origin in the functional review deployment. GitHub Pages can continue to host the public marketing and legal mirror, but it cannot execute OAuth, protect client credentials, or receive video uploads. When `app.html` is opened on GitHub Pages, it reports that the secure backend is unavailable instead of simulating a working connection.

## Files and public pages

| Path | Purpose |
| --- | --- |
| `index.html` | Public product overview and direct links to Terms and Privacy |
| `about.html` | Audience, Music Short Factory workflow, creator control, and Content Posting API boundary |
| `app.html` / `app.js` | Real creator UI for connection, local preview, draft or Direct Post selection, account-specific settings, confirmation, transfer, status, disconnection, and session-data deletion |
| `support.html` | Support contact, troubleshooting, and FAQ |
| `privacy.html` | Privacy Policy at the existing public path |
| `terms.html` | Terms of Service at the existing public path |
| `data-deletion.html` | TikTok revocation and operator-controlled deletion instructions |
| `404.html` | Static-host fallback |
| `styles.css` / `script.js` | Shared responsive styles and accessible navigation |
| `server/` | Minimum OAuth, token storage, Creator Info, draft upload, Direct Post, status, disconnect, and deletion backend |
| `verification/` | Optional TikTok URL-prefix signature file, served at the public site root |
| `.env.example` | Configuration names and safe placeholders; never production values |
| `Dockerfile` | Reproducible Node production container |
| `sitemap.xml`, `robots.txt`, `.nojekyll` | Public discovery and GitHub Pages compatibility |

## Backend routes

| Route | Purpose |
| --- | --- |
| `GET /api/session` | Creates or reads the essential session and returns safe connection state, CSRF token, limits, and latest upload status |
| `GET /auth/tiktok` | Starts TikTok Login Kit authorization with the fixed required scopes |
| `GET /auth/tiktok/callback` | Validates OAuth state, exchanges the code on the server, and stores encrypted tokens |
| `GET /api/creator-info` | Loads the authorized creator's current Direct Post privacy, interaction, and duration restrictions from TikTok |
| `POST /api/upload` | Accepts the selected video, publishing mode, required settings and confirmation; requires `X-CSRF-Token` and starts a draft or Direct Post transfer |
| `GET /api/publish/status?publishId=...` | Checks the status of the session's specified TikTok publishing transfer |
| `POST /api/disconnect` | Requires CSRF protection, revokes TikTok access, and deletes the stored connection |
| `POST /api/delete-data` | Requires CSRF protection and deletes operator-controlled data for the browser session |
| `GET /api/health` | Checks that the application and configured database are available |

## Local setup

Requirements:

- Node.js 22.13 or newer;
- a TikTok for Developers app with Login Kit and Content Posting API enabled for Sandbox testing;
- TikTok Sandbox test users added in the Developer Portal.

Install dependencies and create a local environment file:

```bash
npm ci
cp .env.example .env
```

Generate a unique 32-byte token-encryption key:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Put the generated value and the Sandbox credentials in `.env`, then run:

```bash
npm start
```

Leave `DATABASE_URL` unset locally to use SQLite. A local PostgreSQL URL can be
supplied when the production adapter itself needs to be exercised.

The pages and non-OAuth API checks can run locally at `http://localhost:3000/`. TikTok OAuth requires an externally reachable HTTPS origin, including during Sandbox testing. Use a trusted HTTPS development tunnel or the production-like HTTPS host, set `PUBLIC_ORIGIN` to that origin, set `TIKTOK_REDIRECT_URI` to the same origin plus `/auth/tiktok/callback`, register that exact Redirect URI in the Developer Portal, and open `/app.html` through the HTTPS origin.

Run the automated checks with:

```bash
npm test
```

## Environment variables

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | Use `production` in the HTTPS deployment |
| `PORT` | HTTP port used by the Node process |
| `PUBLIC_ORIGIN` | Exact externally accessible origin, with no path; HTTPS is required in production |
| `TIKTOK_CLIENT_KEY` | TikTok app Client Key; server-side configuration |
| `TIKTOK_CLIENT_SECRET` | TikTok app Client Secret; server secret, never expose or commit it |
| `TIKTOK_REDIRECT_URI` | Must equal `${PUBLIC_ORIGIN}/auth/tiktok/callback` exactly |
| `TIKTOK_DIRECT_POST_AUDITED` | Leave `0` until TikTok approves Direct Post for public use; use `1` only after that audit is complete |
| `TOKEN_ENCRYPTION_KEY` | Unique 32-byte key used for AES-256-GCM encryption of OAuth tokens |
| `SESSION_COOKIE_NAME` | Opaque essential-session cookie name; use a secure `__Host-` name in production |
| `SESSION_TTL_SECONDS` | Session lifetime |
| `OAUTH_STATE_TTL_SECONDS` | Short OAuth state lifetime |
| `DATABASE_URL` | Neon PostgreSQL connection URL with `sslmode=require`; required and secret in production |
| `DATABASE_PATH` | Local SQLite path; ignored when `DATABASE_URL` is present |
| `UPLOAD_DIR` | Private temporary upload directory; `/tmp/adh-uploads` on Render |
| `MAX_UPLOAD_BYTES` | Deployment upload limit, within TikTok's applicable limit |
| `TRUST_PROXY` | Set to `1` behind the Render HTTPS proxy |

Never place `.env`, SQLite files, uploaded videos, client secrets, access tokens, or refresh tokens in Git or a public frontend.

## Production deployment

The zero-cost review deployment uses one Render Free Web Service for the static
pages and Node backend, plus one Neon Free PostgreSQL database. GitHub `main` is
the only code source and Render auto-deploys that branch. Do not attach a Render
persistent disk: account state belongs in PostgreSQL, while selected videos exist
only temporarily under `/tmp/adh-uploads` and are removed after each attempt.

Recommended sequence:

1. Create the Neon Free database and copy its PostgreSQL connection URL without
   placing it in a local file or Git.
2. Connect the GitHub repository and `main` branch to a Render Web Service using
   the existing Dockerfile and the Free instance type.
3. Do not create a persistent disk, Redis, Key Value instance, or media storage.
4. Configure Render secrets for `DATABASE_URL`, the TikTok credentials, and
   `TOKEN_ENCRYPTION_KEY`.
5. Set `NODE_ENV=production`, `TRUST_PROXY=1`, and
   `UPLOAD_DIR=/tmp/adh-uploads`.
6. After Render assigns the real HTTPS hostname, set `PUBLIC_ORIGIN` to that
   origin and `TIKTOK_REDIRECT_URI` to the same origin plus
   `/auth/tiktok/callback`.
7. Configure `/api/health` as the Render health-check path and confirm it returns
   HTTP 200 with both application and database available.
8. Register the exact URLs and all three scopes in the TikTok Developer Portal,
   authorize the Sandbox account, and test both a real draft transfer and a
   Direct Post allowed by the current audit restrictions.

Free services have operational limits. Render can sleep after inactivity and
Neon can suspend idle compute, so warm and verify the complete flow immediately
before recording the review demonstration. Staying within each provider's Free
quotas keeps this deployment at zero cost; no paid plan is required by the code.

The static GitHub Pages site remains available at:

<https://aleseixas.github.io/music-short-factory-site/>

For App Review, use the functional HTTPS deployment as the Website URL so the Home, creator tool, support, and legal pages are available on one working product origin. The backend rewrites canonical and Open Graph URLs to the active production host when it serves the pages. The existing GitHub Pages legal URLs may remain public during that transition.

## TikTok Developer Portal alignment

Use one consistent public identity throughout the portal and demonstration:

- **App Name:** `Além do Hit`
- **Workflow name shown in the product:** `Music Short Factory`
- **Website URL:** the functional production HTTPS origin
- **Privacy Policy URL:** `${PUBLIC_ORIGIN}/privacy.html`
- **Terms of Service URL:** `${PUBLIC_ORIGIN}/terms.html`
- **Redirect URI:** `${PUBLIC_ORIGIN}/auth/tiktok/callback`
- **Products:** Login Kit and Content Posting API
- **Scopes:** `user.info.basic`, `video.upload`, `video.publish`

Enable both Upload and Direct Post for Content Posting API. The authorization screen, portal configuration, public copy, Privacy Policy, Terms, and recorded demonstration should show the same app name, URLs, scopes, and real behavior. An account that authorized only the earlier scope set must disconnect and authorize again before Direct Post can work.

In the Development configuration, also add the exact production HTTPS origin as a trusted domain and verify the configured URL properties. DNS verification is the simplest option when you control the domain. If TikTok provides a URL-prefix signature file instead, place the unchanged `.txt` or `.html` file in `verification/`, redeploy, and confirm it is available at `https://your-public-origin.example/<signature-filename>` with HTTP 200 and no redirect before completing verification.

## Sandbox end-to-end check

Before recording the review video:

1. Add the TikTok account used in the demonstration as an authorized Sandbox user.
2. Confirm the production Redirect URI exactly matches the portal entry.
3. Open the functional HTTPS `/app.html` in a clean browser session.
4. Connect TikTok and confirm the authorization screen requests `user.info.basic`, `video.upload`, and `video.publish`.
5. Verify the returned display name or avatar belongs to the account just authorized.
6. Select a small, rights-cleared test video and play the local preview.
7. Test **Send as draft**, confirm the button remains disabled until explicit consent, and verify delivery to the TikTok inbox.
8. Select **Publish directly** and confirm the tool loads the creator name, privacy options, interaction availability, and duration limit from TikTok rather than using a fixed list.
9. Choose an available privacy option, keep comments, Duet, and Stitch unchecked unless deliberately enabled, complete the required disclosure and music confirmations, and publish only after explicit confirmation.
10. Follow the returned `publish_id` until TikTok reports a terminal status, then verify the private Direct Post on the authorized Sandbox account.
11. Return to the tool and demonstrate Disconnect TikTok or Delete my data.

Use an original or otherwise authorized test video. Do not expose credentials, tokens, the `.env` file, private browser data, or a Client Secret while recording.

## What to show in the App Review video

Record one clear, continuous flow that shows:

1. the public Home page, product explanation, Terms, Privacy, Support, and Data Deletion links;
2. the real creator tool with no pre-authorized account;
3. TikTok Login Kit and the exact requested scopes;
4. the same authorized creator account displayed after callback;
5. selection and playback of the exact video being sent;
6. the choice between draft and Direct Post, plus the explicit consent control and creator-initiated action;
7. real upload progress and the status returned through Content Posting API;
8. a draft arriving in that creator's TikTok inbox or editor;
9. for Direct Post, Creator Info options loaded for the same account, editable caption, selected privacy and permitted interaction settings, required disclosures, and final confirmation;
10. the real Direct Post status and private post on the authorized Sandbox account; and
11. revocation or deletion controls if the review form asks for them.

The recording must demonstrate a real Sandbox transaction. Do not replace a failed API step with a mock screen or edited result.

## Intentional limits

- One creator-controlled TikTok connection per browser session.
- One local video selected and confirmed per transfer.
- Draft upload and creator-confirmed Direct Post only; no unattended or scheduled publication.
- Draft settings remain in TikTok. Direct Post shows an editable caption and only the privacy, comments, Duet, Stitch, duration, and disclosure controls permitted by TikTok for the connected creator.
- Until TikTok audits Direct Post, it is limited to private target accounts and `SELF_ONLY` posts under TikTok's development restrictions.
- No payments, subscriptions, teams, analytics dashboard, social feed, or administrative product area.
- No permanent media library; selected videos are normally deleted immediately after the transfer attempt, with startup/hourly cleanup for recognized temporary files older than six hours.
- Access may remain limited to TikTok Sandbox users until review and audit are complete.

TikTok approval is not guaranteed by the website or implementation. Approval also depends on the Developer Portal configuration, account eligibility, review evidence, compliance with current TikTok policies, and the behavior observed by TikTok reviewers.

## Security and privacy summary

- The Client Secret and OAuth token exchange remain on the backend.
- Access and refresh tokens are encrypted with AES-256-GCM before PostgreSQL or local SQLite storage.
- The browser receives an opaque, essential session cookie rather than TikTok tokens.
- OAuth state and CSRF tokens protect authorization and state-changing requests.
- The video is previewed locally before consent and reaches the backend only after confirmation.
- Temporary video files are removed after transfer completion, failure, or expiry.
- Disconnect revokes the TikTok authorization and deletes the stored connection.
- The data-deletion route removes records controlled by the application for the active session.
- Personal information and TikTok user data are not sold or used for behavioral advertising.

## Public URLs

- Home: <https://aleseixas.github.io/music-short-factory-site/>
- Creator tool mirror: <https://aleseixas.github.io/music-short-factory-site/app.html>
- About & How It Works: <https://aleseixas.github.io/music-short-factory-site/about.html>
- Support: <https://aleseixas.github.io/music-short-factory-site/support.html>
- Privacy Policy: <https://aleseixas.github.io/music-short-factory-site/privacy.html>
- Terms of Service: <https://aleseixas.github.io/music-short-factory-site/terms.html>
- Data Deletion: <https://aleseixas.github.io/music-short-factory-site/data-deletion.html>

## Review readiness checklist

- [ ] Functional HTTPS deployment is live.
- [ ] App Name and icon match the Developer Portal.
- [ ] Website, Privacy, Terms, and Redirect URLs match production exactly.
- [ ] Production origin is a trusted domain and the configured URL properties are verified.
- [ ] Login Kit and Content Posting API are enabled.
- [ ] Only `user.info.basic`, `video.upload`, and `video.publish` are requested.
- [ ] Sandbox reviewer/test account is authorized.
- [ ] OAuth callback completes without exposing credentials.
- [ ] Selected video preview works before confirmation.
- [ ] Draft upload and Direct Post are disabled until their explicit confirmations are complete.
- [ ] Real draft upload reaches the authorized TikTok inbox.
- [ ] Direct Post options come from Creator Info for the connected account.
- [ ] A real private Direct Post completes in Sandbox under unaudited-client restrictions.
- [ ] Disconnect and data deletion work.
- [ ] Temporary uploaded video is removed from the backend.
- [ ] Repository and deployment contain no committed secrets or user media.
- [ ] Continuous App Review demonstration video is recorded.

## Contact

Além do Hit Support: [alelseixas@gmail.com](mailto:alelseixas@gmail.com)
