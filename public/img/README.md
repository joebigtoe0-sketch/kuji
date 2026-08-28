# Drop brand assets here

Files in this folder are served at `/img/...` and picked up automatically —
no code change, no restart needed. Everything is optional; each slot falls
back to the CSS wordmark or is simply left out, so a missing file never
renders as a broken image.

| filename | what it becomes | ideal size |
|---|---|---|
| `logo.png` | favicon, the icon beside the wordmark, and the social preview if `og.png` is absent | square, 512×512 |
| `wordmark.png` | **replaces** the "KUJI" text in the header | transparent, ~840×200 (height is scaled to 42px) |
| `og.png` | link preview when the site is shared on X / Discord | 1200×630 |

`.png`, `.svg`, `.webp` and `.jpg` all work — first match wins, so
`logo.svg` is used over `logo.png` if both exist.

Transparent backgrounds are best: the site ground is near-black
(`#03060f`) and a white box around a logo will show.

## Not served from here

- **Token image** (ClawPump): uploaded at launch on their site. Use `logo.png`,
  square, and check it still reads at 24px — that is the size wallets and
  charts render it at.
- **X avatar and banner**: uploaded to X directly. Avatar is cropped to a
  circle, so keep the mark centred with margin.
