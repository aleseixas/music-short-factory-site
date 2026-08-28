# Além do Hit — official website

Simple, static, multi-page website for **Além do Hit**, an independent music editorial project focused on short-form educational and documentary stories.

**Music Short Factory** appears only as the name of the internal desktop workflow used to organize research, scripts, assets, video production, review, metadata, and publishing preparation. It is not presented as a large public SaaS product.

The site is written in English for an international audience and can be used as the public Website URL during TikTok for Developers App Review. It does not claim TikTok approval, public product availability, customers, metrics, partnerships, or features that do not exist.

## Public URL

<https://aleseixas.github.io/music-short-factory-site/>

The site uses plain HTML, CSS, and a small JavaScript file. It has no framework, package installation, build step, backend, database, authentication, account dashboard, analytics, or API calls.

## Site structure

| File | Public page | Purpose |
| --- | --- | --- |
| `index.html` | `/` | Brand overview, audience, workflow summary, creator control, short TikTok note, privacy, FAQ, and direct legal links |
| `about.html` | `/about.html` | About and complete Research → Story → Video → Review → Publish workflow |
| `support.html` | `/support.html` | Contact, support topics, and FAQ |
| `privacy.html` | `/privacy.html` | Privacy Policy |
| `terms.html` | `/terms.html` | Terms of Service |
| `data-deletion.html` | `/data-deletion.html` | TikTok authorization revocation and operator-controlled data deletion instructions |
| `404.html` | GitHub Pages fallback | Helpful not-found page |
| `styles.css` | Shared asset | Responsive visual system and print styles |
| `script.js` | Shared asset | Accessible mobile navigation and current footer year |
| `assets/alem-do-hit-og.png` | Social asset | Open Graph preview image |
| `sitemap.xml` | Discovery | Public page inventory |
| `robots.txt` | Discovery | Crawler policy and sitemap location |
| `.nojekyll` | GitHub Pages | Keeps deployment on the plain static-file path |

The former separate `how-it-works.html` content was consolidated into `about.html`. The former `tiktok-integration.html` page was removed; a short, transparent integration section now appears on the Home and About pages.

## Test locally

No dependencies are required. From the repository root:

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000/
```

Recommended checks:

1. Open every page from the header, Home policy links, and footer.
2. Test the mobile navigation and keyboard focus.
3. Check the workflow, cards, and policy tables at narrow widths.
4. Confirm every email link uses `alelseixas@gmail.com`.
5. Confirm Terms and Privacy are visible directly in the Home body.
6. Scan the public repository for credentials before every deployment.

## GitHub Pages

Expected configuration:

- deployment branch: `main`;
- deployment directory: repository root;
- custom build: none;
- Jekyll processing: disabled by `.nojekyll`.

After committing and pushing, wait for the GitHub Pages workflow to finish and verify the live URLs below. Do not rename `terms.html` or `privacy.html`; those paths are already registered in the TikTok Developer Portal.

## What this repository does not contain

This repository is intentionally limited to the public website. It does not contain:

- TikTok OAuth implementation or redirect handling;
- client secrets, authorization tokens, or creator credentials;
- Content Posting API calls;
- uploads, webhooks, queues, or protected media hosting;
- user accounts, authentication, a database, or a dashboard; or
- a simulated TikTok login or publishing interface.

GitHub Pages cannot securely perform a confidential OAuth exchange or store creator tokens. Any real TikTok authorization and publishing flow must remain in the desktop application's secure operational architecture and any backend that flow genuinely requires.

## Website checklist

- [x] Public Home page
- [x] Public About & How It Works page
- [x] Public Support page
- [x] Public Privacy Policy at `privacy.html`
- [x] Public Terms of Service at `terms.html`
- [x] Public revocation and data deletion page
- [x] Short, transparent TikTok integration explanation
- [x] Terms and Privacy visible directly on Home
- [x] Primary branding is Além do Hit
- [x] Music Short Factory described only as an internal workflow
- [x] No backend, database, authentication, or framework
- [x] No secret or production credential intentionally stored in the repository
- [x] Responsive desktop and mobile layouts
- [x] Open Graph image, `404.html`, `robots.txt`, `sitemap.xml`, and `.nojekyll` preserved
- [x] Relative links compatible with the GitHub Pages project path
- [ ] Final live URLs verified after deployment

## TikTok App Review work outside this repository

The website supplies a professional public identity, support contact, legal documents, and integration transparency. It cannot by itself complete App Review. Before submission, verify in the real application and Developer Portal that:

- the app name, icon, description, Website URL, Terms URL, and Privacy URL are consistent;
- only the platform products and scopes genuinely used by the demonstrated app are requested;
- OAuth redirect handling and confidential credentials are implemented securely outside GitHub Pages;
- the creator authorizes the destination TikTok account;
- the real publishing screen uses the latest creator information returned by TikTok and shows only available privacy and interaction settings;
- the creator can review the video and editable metadata and explicitly confirm before transfer or Direct Post;
- revocation and deletion requests sent to `alelseixas@gmail.com` can be handled operationally;
- the required sandbox demonstration, product review, and Content Posting API audit materials are complete; and
- all current TikTok developer policies and review instructions are checked again immediately before submission.

The website does not guarantee approval. TikTok evaluates the functioning application, requested permissions, portal configuration, and review evidence in addition to the public website.

## Important URLs

- Home: <https://aleseixas.github.io/music-short-factory-site/>
- About & How It Works: <https://aleseixas.github.io/music-short-factory-site/about.html>
- Support: <https://aleseixas.github.io/music-short-factory-site/support.html>
- Privacy Policy: <https://aleseixas.github.io/music-short-factory-site/privacy.html>
- Terms of Service: <https://aleseixas.github.io/music-short-factory-site/terms.html>
- Data Deletion: <https://aleseixas.github.io/music-short-factory-site/data-deletion.html>

## Contact

Além do Hit: [alelseixas@gmail.com](mailto:alelseixas@gmail.com)
