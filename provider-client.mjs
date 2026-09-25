import { recoveryError, providerError, parseRetryAfter, RecoveryError } from './recovery-errors.mjs';

// Credentials remain only in this server process. No retries: an interrupted
// connection cannot establish whether an upstream billable operation ran.
export function readConfiguration(env = process.env) {
  const key = env.TILE_API_KEY?.trim() || '';
  const model = env.TILE_API_MODEL?.trim() || '';
  const imageModel = env.TILE_IMAGE_MODEL?.trim() || '';
  let endpoint;
  try {
    const base = new URL(env.TILE_API_BASE_URL || 'https://api.openai.com/v1');
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
    if ((base.protocol !== 'https:' && !(loopback && base.protocol === 'http:')) || base.username || base.password || base.search || base.hash) throw new Error();
    base.pathname = base.pathname.replace(/\/+$/, '') + '/responses';
    endpoint = base;
  } catch { return { configured: false, key: '', model: null, imageModel: null, endpoint: null }; }
  const validModel = value => /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(value) && !value.includes(key);
  const configured = Boolean(key && !/[\r\n]/.test(key) && key.length <= 4096 && validModel(model) && (!imageModel || validModel(imageModel)));
  return { configured, key, model: configured ? model : null, imageModel: configured ? imageModel || null : null, endpoint };
}
const config = readConfiguration();
export const MODEL = config.model;
export const IMAGE_MODEL = config.imageModel;
export function providerHealth() {
  return { configured: config.configured, proxyReachable: config.configured, model: MODEL, imageModel: IMAGE_MODEL, endpointOrigin: config.endpoint?.origin || null };
}

async function boundedJson(response, maximum) {
  if (Number(response.headers.get('content-length')) > maximum) { await response.body?.cancel(); throw recoveryError('invalid_image'); }
  const reader = response.body?.getReader();
  if (!reader) throw recoveryError('incomplete_output');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) { await reader.cancel(); throw recoveryError('invalid_image'); }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw recoveryError('incomplete_output'); }
  } finally { reader.releaseLock(); }
}

export async function generateImage({ content, signal, onPhase = () => {}, configuration = config, timeoutMs = 300_000 }) {
  if (!configuration.configured) throw recoveryError('not_configured');
  if (signal?.aborted) throw recoveryError('cancelled', { executionState: 'not_started' });
  const controller = new AbortController(); let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const started = performance.now();
  try {
    const payload = JSON.stringify({ model: configuration.model, store: false, stream: false,
      input: [{ role: 'user', content }],
      tools: [{ type: 'image_generation', ...(configuration.imageModel ? { model: configuration.imageModel } : {}) }],
      tool_choice: { type: 'image_generation' } });
    if (Buffer.byteLength(payload) > 40 * 1024 * 1024) throw recoveryError('invalid_input');
    onPhase('request_sent');
    const response = await fetch(configuration.endpoint, { method: 'POST', redirect: 'manual',
      headers: { Authorization: `Bearer ${configuration.key}`, 'Content-Type': 'application/json' },
      body: payload, signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel();
      // Never parse or echo arbitrary provider errors (they can include secrets).
      throw providerError({ httpStatus: response.status, retryAfterMs: parseRetryAfter(response.headers.get('retry-after')) });
    }
    onPhase('receiving_output');
    const body = await boundedJson(response, 70 * 1024 * 1024);
    const output = Array.isArray(body.output) && body.output.find(item => item.type === 'image_generation_call' && typeof item.result === 'string');
    if (!output) throw recoveryError('incomplete_output');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(output.result) || output.result.length % 4) throw recoveryError('invalid_image');
    const bytes = Buffer.from(output.result, 'base64');
    if (!bytes.length || bytes.length > 50 * 1024 * 1024 || bytes.toString('base64') !== output.result) throw recoveryError('invalid_image');
    const safeModel = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(value) && !value.includes(configuration.key) ? value : null;
    const elapsedMs = Math.round(performance.now() - started);
    return { bytes, elapsedMs, outputAtMs: elapsedMs, responseModel: safeModel(body.model), responseImageModel: safeModel(output.model),
      responseCompleted: body.status === 'completed', phases: [],
      ...(body.status !== 'completed' ? { warning: 'An image was received, but the provider did not confirm completion. The saved image is available.', warningCode: 'completion_unconfirmed' } : {}) };
  } catch (error) {
    if (timedOut) throw recoveryError('timeout');
    if (signal?.aborted) throw recoveryError('cancelled');
    if (error instanceof RecoveryError) throw error;
    throw recoveryError('network_disconnected');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

