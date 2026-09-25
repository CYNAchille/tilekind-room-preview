# Tilekind Room Preview

Draw tiled regions on a room image and preview textures with perspective, grout, layers and protected areas. Use the local non-AI preview for free, or optionally generate an AI room image through **your own API account**.

Prepared for [Tilekind](https://tilekind.com.au/). This is an experimental visual planning tool, not a measurement, specification or installation tool.

## Run

Install Node.js 22.9 or later. In this folder run:

```sh
npm ci
npm start
```

Open the local address printed by the server. The non-AI preview needs no API key and sends no provider requests. Keep the terminal open; Ctrl+C stops the server. For AI setup, copy `.env.example` to `.env`, configure your own provider and model, and follow [AI-SETUP.md](AI-SETUP.md). Generation may cost money on your API account.

## Try it

1. Select Floor or Back wall on the drawn demo room.
2. Choose a texture in the region settings, then open **Tile preview (non-AI)**.
3. Adjust layout, rotation, scale and grout. Use **Edit regions** to change boundaries.
4. Use Four corners or Rectangle to add regions; Protect outlines furniture or windows that should keep the original image. Up to four regions are supported.
5. Undo/redo edits with the toolbar or Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z. Download the preview as PNG.
6. Choose room to load your own JPG, PNG or WebP. Loading an image stays local. AI generation asks before sending it to your configured provider and saving a job locally. Submitted AI designs have recovery support when browser storage is available; this is not a general project-saving feature.

The demo room and three texture swatches are geometric fixtures created for this package. They are not real product images or AI-generated photographs. `npm run fixtures` regenerates them reproducibly.

## What the preview means

It projects a repeated texture into a four-corner plane. Plane dimensions are assumptions from the demo or editor defaults, not measurements recovered from the image. Display colours, scale and grout are illustrative; the preview does not calculate quantities, lighting, slip ratings or installation suitability. Check physical samples and actual product data before purchase or specification.

A modern browser with WebGL is required. Large uploads are reduced locally to a maximum 2,048-pixel edge. This is a desktop-first experimental editor for a single trusted local user; it is not a hardened hosted application. The supplied server binds to loopback only. Keep its job storage private.

## Optional AI generation

The backend supports providers implementing Responses API image generation. Set the API base URL, key and model on your own computer. Keys are server-side only; no key or paid service is bundled. Chat-only API compatibility does not imply image-tool compatibility. See [AI-SETUP.md](AI-SETUP.md) for the exact protocol and configuration.

Each request includes all selected regions. Stable request identities, local job records and result-to-design matching support recovery without silently generating another image. Timeout or cancellation does not guarantee the provider stopped processing or billing. A new attempt requires confirmation; opening an existing result does not create another image.

## Check

```sh
npm test
```

Tests cover perspective corner mapping, inverse mapping, invalid geometry, winding and the local HTTP/asset boundary. Browser rendering and editing require manual checks; Node tests are not a substitute for visual QA.

## Licence and verification

Code and generated example fixtures are provided under the [MIT License](LICENSE). Tilekind branding is not a grant of trademark rights. `private: true` prevents accidental npm publication; it does not restrict use under MIT. See [PROVENANCE.md](PROVENANCE.md) for source and asset boundaries.

Desktop Chrome checks for the first preview version covered rendering, material changes, undo/redo, outline adjustment, deleting and restoring regions. A user confirmed the export button opened Chrome's Save dialog; saved-file contents were not independently checked. Automated photo selection was blocked at the browser file chooser, so photo upload has not completed manual verification. Mobile use has not been verified. AI tests use a mock provider; no paid live-provider result is claimed. No third-party room photos, supplier textures, customer data or original experiment output files are distributed in this package.
