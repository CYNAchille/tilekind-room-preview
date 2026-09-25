# Changes

## 0.2.0

- Optional AI generation using a server-side, user-configured Responses API account.
- No bundled key or private model defaults. Preview still works without configuration.
- Confirmation before a new AI attempt explains the image destination, local recovery storage and possible provider charges.
- Local durable job lookup, request identity deduplication, cancellation and result recovery adapted from the original editor.
- Example SVG references are rasterised for image input; examples remain synthetic.
- API errors use safe messages; provider redirects are not followed with credentials.
- No paid live-provider generation is claimed by the mock test suite.

## 0.1.0

- Standalone non-AI tile preview, multi-region canvas editor, geometric example room and textures.
- Geometry tests and local HTTP checks; MIT licence.
