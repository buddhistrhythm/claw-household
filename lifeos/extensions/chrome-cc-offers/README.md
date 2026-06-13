# lifeos · CC offers (Chrome extension)

Bulk-add credit card sign-up offers seen on any page (DoctorOfCredit,
FrequentMiler, issuer landing pages, /r/churning, etc.) into your lifeos
inbox. The extension is just another **Source** feeding the existing
capture pipeline (see `docs/SPEC-plugins.md`) — one HTTPS POST, server
extracts the offer list, each offer becomes a `planned`
`credit_card_application` entity you can review in the inbox / 收件 tab.

## Install (unpacked)

1. Clone the lifeos repo and start the web server somewhere reachable by
   your browser:

   ```sh
   export DATABASE_URL=postgres://lifeos:lifeos@127.0.0.1:5432/lifeos
   export LIFEOS_WEB_TOKEN=<long-random-string>   # required for non-localhost
   node src/cli.js web                            # serves on :8850
   ```

   On a Tailscale setup just expose it as
   `https://lifeos.<tailnet>.ts.net` — no separate compose entry needed,
   the existing web service handles `/api/captures`.

2. In Chrome: open `chrome://extensions`, flip on **Developer mode**
   (top right), click **Load unpacked**, and select this
   `extensions/chrome-cc-offers/` directory.

3. Right-click the toolbar icon → **Options** (or open the popup once,
   it'll prompt you). Fill in:

   - **Endpoint URL** — e.g. `http://127.0.0.1:8850` or your tailnet URL.
   - **Token** — same value you set in `LIFEOS_WEB_TOKEN`. Leave blank
     when the server has no token (only safe on localhost).

   Hit **Save**.

## Use

On any page with credit card offers (DoC list page, FM offer roundup,
Chase / Amex landing page, a reddit thread), click the lifeos toolbar
icon. The popup shows:

- The page title + URL.
- A textarea pre-filled with the page's visible text — edit freely to
  trim chrome / nav / unrelated sections, paste in extra content, etc.

Click **Send to lifeos**. The popup will display:

- HTTP status + `route.intent` (will be `credit_card.bulk_offers`).
- Number of offers extracted and `planned` applications created.
- The first ~5 card names if the server echoed them.

Open the lifeos web app → **inbox / 收件** tab to review each new
`credit_card_application`. Every entity carries
`notes: "Source: <url>"` plus a `captured_from` edge back to the
capture, so traceability never gets lost even when extraction is
imperfect.

## Icons

This repo is binary-free on purpose — no `icons/` folder ships with
the extension. Chrome will fall back to its default puzzle-piece icon
on the toolbar. Drop your own `icons/16.png`, `48.png`, `128.png` and
re-add an `"icons"` key to `manifest.json` if you'd like a custom one.

## Permissions, briefly

- `activeTab` — read the page you're currently on, only when you click
  the icon. The extension never observes other tabs.
- `storage` — store your endpoint + token in `chrome.storage.sync`.
- `scripting` — used once per click to grab `document.title`,
  `document.body.innerText`, and `location.href`.
- `host_permissions: ["<all_urls>"]` — needed because "any page with
  offers" can't be enumerated up front. If you want to lock down to
  specific sites, edit `manifest.json` and replace `"<all_urls>"` with
  e.g. `"https://www.doctorofcredit.com/*"` and other hosts you trust.

## Request shape

```
POST {endpoint}/api/captures
Content-Type: application/json
Authorization: Bearer {LIFEOS_WEB_TOKEN}     (omitted if no token)

{
  "text": "<edited page text>",
  "channel": "chrome-cc-offers",
  "hints": {
    "domain": "finance",
    "kind": "cc_offers",
    "url": "https://www.doctorofcredit.com/...",
    "title": "Best Current Credit Card Bonuses"
  }
}
```

The `hints.kind=cc_offers` tag is what makes the server route this
deterministically to the `credit_card.bulk_offers` intent — the LLM
never picks the intent, only (optionally) extracts the offer list.

## Troubleshooting

- **401 Unauthorized** — token mismatch. Re-check the **Options** page.
- **Network error** — `LIFEOS_WEB_HOST=0.0.0.0` may be required if
  Chrome can't reach 127.0.0.1 from inside a container.
- **0 offers extracted** — paste a cleaner slice of the page (just the
  card section). The server-side regex is heuristic; if
  `ANTHROPIC_API_KEY` is set on the server side and the regex misses,
  it'll fall back to an LLM extractor automatically.
