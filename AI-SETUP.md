# Optional AI generation with your own API

The texture preview works without a provider. AI generation uses your own API account and may incur charges. Tilekind does not supply a key, proxy account, model subscription or hosted service.

## Configure locally

1. Install the dependencies with `npm ci`.
2. Copy `.env.example` to `.env` in the project root.
3. Set `TILE_API_KEY` and `TILE_API_MODEL` using your provider's documentation and the models available to your account. Do not put credentials in `public/`, screenshots, issues or commits.
4. Leave `TILE_API_BASE_URL=https://api.openai.com/v1` for OpenAI, or set your own provider's HTTPS API base URL including its version path. The application appends `/responses`.
5. Optionally set `TILE_IMAGE_MODEL` if your provider supports an explicit model on the image-generation tool.
6. Run `npm start`. Open the local address printed by the server. Check **Choose room > AI connection**.

Configuration status is not a live balance, authentication or model-access test. The application makes no provider request just to check configuration. Restart the server after changing environment variables.

## Supported protocol

The provider must support the **Responses API with the `image_generation` tool**, multiple `input_image` data URLs, and an `image_generation_call` result containing a base64 image. A service that only offers Chat Completions or `/images/generations` is not sufficient. Compatibility is provider-specific; this release does not certify third-party providers.

The main requested model and optional image tool model are separate settings. A returned image does not prove a particular image model ran; missing returned model identity remains unknown. No private model names or credentials are bundled.

Reference: [OpenAI image generation guide](https://developers.openai.com/api/docs/guides/image-generation), consulted 2026-09-25. Model availability and pricing depend on the provider and account.

## What gets sent and saved

Loading a room image and using the non-AI preview stay local. Starting an AI attempt asks for confirmation before sending the room image, an annotated region guide, selected example textures and instructions to the configured provider. Only share images you have permission to send. Review that provider's retention and privacy terms.

For recovery, submitted job information and generated images are stored on your computer. Browser storage can retain a submitted design. Do not use this local prototype on a shared computer for confidential images without understanding these files and browser copies. It is not an encrypted image vault or a multi-user hosted service.

API keys stay on the local server, are not included in browser responses, and must not be committed. The supplied `.gitignore` excludes `.env`, job records, temporary work and generated files. A hostname or model name may be shown so you can verify the destination; the key is not displayed.

## Recovery and billing

Check the original job after a dropped connection. Reloading an existing result does not request another image. A deliberate **new attempt** may incur another charge. The application does not silently switch models or automatically resubmit a failed generation.

Cancellation and timeouts cannot guarantee that the provider stopped work or waived a charge. A result is matched to the submitted design; changing materials or geometry does not relabel an old result.

## Limits

AI can change unselected details, cross boundaries or misrepresent a tile's appearance. Check the output, real samples and product documentation. Outputs are not installation plans or quantity calculations. The included room and textures are synthetic examples, not actual products.

The local server is intended for one trusted user on the same computer. Do not expose it to a network or use it as a production upload service without a separate deployment design. Tests use a local mock provider; a live paid API call is not part of the automated test suite.
