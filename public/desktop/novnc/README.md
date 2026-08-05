# noVNC assets (optional vendor tree)

Production builds may **vendor** [@novnc/novnc](https://github.com/novnc/noVNC)
here so the SPA does not depend on a CDN.

Default `desktop.js` loads RFB from jsDelivr:

```text
https://cdn.jsdelivr.net/npm/@novnc/novnc@1.5.0/lib/rfb.js
```

To vendor:

```bash
# from edge-web/
npm pack @novnc/novnc@1.5.0
# extract lib/ + core/ + vendor/ into public/desktop/novnc/
```

Then point the import in `desktop.js` at `./novnc/lib/rfb.js`.

Clipboard remains disabled in the SPA embed (design v1).
