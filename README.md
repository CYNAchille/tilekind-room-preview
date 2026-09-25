# Tilekind Room Preview

Draw tiled regions on a room image and preview textures with perspective, grout, layers and protected areas. This version runs entirely with a local server and browser rendering. **It does not generate AI images.**

Prepared for [Tilekind](https://tilekind.com.au/). This is an experimental visual planning tool, not a measurement, specification or installation tool.

## Run

Install Node.js 22 or later. In this folder run:

```sh
npm start
```

Open http://127.0.0.1:4186. There are no npm dependencies, installation step, API keys or external service requests. Keep the terminal open; Ctrl+C stops the server. `PORT` can select another local port.

## Try it

1. Select Floor or Back wall on the drawn demo room.
2. Choose a texture in the region settings, then open **Tile preview (non-AI)**.
3. Adjust layout, rotation, scale and grout. Use **Edit regions** to change boundaries.
4. Use Four corners or Rectangle to add regions; Protect outlines furniture or windows that should keep the original image. Up to four regions are supported.
5. Undo/redo edits with the toolbar or Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z. Download the preview as PNG.
6. Choose room to load your own JPG, PNG or WebP. The image stays in browser memory. Reloading loses edits; there is no saved project feature in this candidate.

The demo room and three texture swatches are geometric fixtures created for this package. They are not real product images or AI-generated photographs. `npm run fixtures` regenerates them reproducibly.

## What the preview means

It projects a repeated texture into a four-corner plane. Plane dimensions are assumptions from the demo or editor defaults, not measurements recovered from the image. Display colours, scale and grout are illustrative; the preview does not calculate quantities, lighting, slip ratings or installation suitability. Check physical samples and actual product data before purchase or specification.

A modern browser with WebGL is required. Large uploads are reduced locally to a maximum 2,048-pixel edge. This is a desktop-first experimental editor; it is not a hardened hosted application. The supplied server binds to loopback only and accepts read-only GET/HEAD requests.

## AI work and roadmap

The private prototype included an AI provider and request recovery. No provider backend, model configuration, credentials, saved requests or generated results are included here. Some original client-side AI/recovery helpers and hidden DOM hooks remain to preserve the editor during this first extraction, but startup does not restore requests, generation is disabled, and the server has no generation endpoint. Their presence is **not** working AI support.

A later version could add a separately configured provider interface, explicit image-upload consent, limits and cancellation, durable request status and retry protection, and a clear distinction between texture preview and AI output. This would require implementation, provider-specific review and fresh tests. Merely unhiding the old UI will not make AI work.

## Check

```sh
npm test
```

Tests cover perspective corner mapping, inverse mapping, invalid geometry, winding and the local HTTP/asset boundary. Browser rendering and editing require manual checks; Node tests are not a substitute for visual QA.

## Licence and verification

Code and generated example fixtures are provided under the [MIT License](LICENSE). Tilekind branding is not a grant of trademark rights. `private: true` prevents accidental npm publication; it does not restrict use under MIT. See [PROVENANCE.md](PROVENANCE.md) for source and asset boundaries.

Automated checks cover geometry and the local HTTP server. Desktop Chrome checks covered rendering, material changes, undo/redo, outline adjustment, deleting and restoring regions. A user confirmed the export button opened Chrome's Save dialog; saved-file contents were not independently checked. Automated photo selection was blocked at the browser file chooser, so photo upload has not completed manual verification for this release. Mobile use has not been verified. No third-party room photos, supplier textures, customer data or original experiment output files are distributed in this package.
