# LinkedIn UK Visa Sponsor Checker

This project creates a Chrome extension that reads LinkedIn job search pages and labels each visible job with:

- `UK Visa Sponsor` in green when the company matches the official UK sponsor list
- `Not a UK Visa Sponsor` in red when no match is found

The extension uses the official CSV in this folder:

- [`2026-04-02_-_Worker_and_Temporary_Worker.csv`](/Users/fanwu/2-Study/Inactive/extension/2026-04-02_-_Worker_and_Temporary_Worker.csv)

It also tries to reduce false negatives by:

- normalizing company names
- stripping legal suffixes like `Ltd` and `Limited`
- handling `T/A` and `trading as` aliases
- checking both the company name on the job card and the company name in the LinkedIn detail panel
- using a limited brand-root fallback for names like `Kaplan Higher Education` vs `Kaplan Financial`

## Files

- [`chrome-extension/manifest.json`](/Users/fanwu/2-Study/Inactive/extension/chrome-extension/manifest.json)
- [`chrome-extension/content-script.js`](/Users/fanwu/2-Study/Inactive/extension/chrome-extension/content-script.js)
- [`chrome-extension/shared/matcher-core.js`](/Users/fanwu/2-Study/Inactive/extension/chrome-extension/shared/matcher-core.js)
- [`chrome-extension/styles.css`](/Users/fanwu/2-Study/Inactive/extension/chrome-extension/styles.css)
- [`scripts/build-sponsors.cjs`](/Users/fanwu/2-Study/Inactive/extension/scripts/build-sponsors.cjs)
- [`scripts/test-matcher.cjs`](/Users/fanwu/2-Study/Inactive/extension/scripts/test-matcher.cjs)

## Build The Sponsor Index

Run:

```bash
npm run build:data
```

That generates:

- [`chrome-extension/data/sponsor-index.json`](/Users/fanwu/2-Study/Inactive/extension/chrome-extension/data/sponsor-index.json)

## Test The Matching Logic

Run:

```bash
npm run test:matcher
```

## Load In Chrome

1. Open `chrome://extensions`
2. Turn on `Developer mode`
3. Click `Load unpacked`
4. Select [`chrome-extension`](/Users/fanwu/2-Study/Inactive/extension/chrome-extension)
5. Open a LinkedIn jobs search page such as `https://www.linkedin.com/jobs/search/...`

## Notes

- The extension only labels what is available on the page. For the currently selected LinkedIn job, it also reads the detail panel and re-checks the selected card with both company names.
- The official sponsor list is legal-entity based, while LinkedIn often shows brand names. The brand-root fallback is intentionally limited, but it can still produce edge-case positives for related companies under the same brand family.
