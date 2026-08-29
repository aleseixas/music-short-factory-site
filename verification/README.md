# TikTok URL-prefix verification files

If the TikTok Developer Portal requires URL-prefix verification instead of DNS verification, place the exact `.txt` or `.html` signature file downloaded from TikTok in this directory and redeploy the Node service.

The server exposes approved files from this directory at the site root. For example:

```text
verification/tiktok-signature.txt
-> https://your-public-origin.example/tiktok-signature.txt
```

Do not rename or edit the downloaded signature file. Confirm that its public URL returns HTTP 200 without a redirect before asking TikTok to verify it.
