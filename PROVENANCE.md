# Provenance and release boundaries

Prepared 2026-09-25 from the existing Tilekind room editor prototype. The original project was preserved. Only the editor frontend, renderer, geometry, recovery helper, loading-animation helper, HTML and styles were copied through an explicit allowlist. Public-facing labels, startup and provider access were adapted for this candidate.

New work in this candidate: read-only loopback Node server, generic display-copy module, deterministic SVG fixture generator, synthetic catalog, tests and release documentation. The SVG generator contains the full source for the schematic room and texture swatches. No photographic or supplier source image was used in these fixtures.

Excluded: original backend/proxy modules and local dependency paths; prompts and AI provider configuration; full original catalog; source room photos and product images; generated images; logs, evidence, saved jobs and uploads; comparison experiments; original reports and private working folders.

Inherited source may have been developed with AI assistance. This extraction does not certify copyright ownership, contributor permission, originality of all inherited code or freedom from third-party obligations. The owner must confirm rights before assigning a license. Tilekind name and branding also remain subject to owner approval; a future code license need not grant trademark rights.

`RELEASE-MANIFEST.json` records the candidate files and SHA-256 hashes, excluding the manifest itself. Rebuild that manifest after any release edit. Test results and browser QA observations are recorded outside this release directory by the coordinating task.
