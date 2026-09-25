import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat, realpath, unlink, readdir, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, isAbsolute, relative, resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { generateImage, providerHealth, MODEL, IMAGE_MODEL } from './provider-client.mjs';
import { buildTilePrompt, createReferencePlan } from './build-prompt.mjs';
import { webPreview, prepareRoomImage, requireSharp } from './image-output.mjs';
import { createGuideImage } from './guide-image.mjs';
import { JobStore, UUID, atomicWrite, requestFingerprint } from './job-store.mjs';
import { RecoveryError, recoveryError, errorPayload } from './recovery-errors.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(ROOT, 'public');
const JOB_EVIDENCE = resolve(ROOT, 'evidence/jobs');
const TEMP = resolve(ROOT, 'private-tmp');
const HOST = '127.0.0.1';
const portSetting = process.env.TILE_EDITOR_PORT ?? '4187';
if (!/^[0-9]{1,5}$/.test(portSetting) || Number(portSetting) < 1 || Number(portSetting) > 65535) throw new Error('TILE_EDITOR_PORT must be an integer from 1 to 65535.');
const PORT = Number(portSetting);
const MAX_BODY = 10 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 7 * 1024 * 1024;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const DEFAULT_SETTINGS = Object.freeze({ groutColor: '#d6d0c5', groutMm: 3, rotation: 0, layout: 'straight', scale: 1 });
const sha256 = value => createHash('sha256').update(value).digest('hex');
const jobs = new Map();
const runningJobs = new Map();
const jobStore = new JobStore(JOB_EVIDENCE);
let activeJobId = null;
let accepting = Promise.resolve();
let shuttingDown = false;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message, code = 'invalid_request') { super(message); this.status = status; this.code = code; }
}

function json(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(data), ...headers });
  res.end(data);
}

function safePath(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/')) throw new HttpError(400, 'Invalid request path.');
  let pathname;
  try { pathname = decodeURIComponent(rawUrl.split('?')[0]); }
  catch { throw new HttpError(400, 'Invalid URL encoding.'); }
  if (/[\\\x00-\x1f:]/.test(pathname) || pathname.split('/').some(p => p === '.' || p === '..')) {
    throw new HttpError(400, 'Invalid request path.');
  }
  return pathname;
}

function isWithin(base, target) {
  const rel = relative(base, target);
  return rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel);
}

async function publicFile(pathname) {
  const candidate = resolve(PUBLIC, '.' + pathname);
  if (!isWithin(PUBLIC, candidate)) throw new HttpError(400, 'Invalid asset path.');
  let actual;
  try { actual = await realpath(candidate); }
  catch { throw new HttpError(404, 'File not found.', 'not_found'); }
  const actualPublic = await realpath(PUBLIC);
  if (!isWithin(actualPublic, actual)) throw new HttpError(403, 'Asset is outside the public directory.', 'forbidden');
  return actual;
}

function readJson(req) {
  const contentType = req.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    req.resume();
    return Promise.reject(new HttpError(415, 'Send application/json.', 'unsupported_media_type'));
  }
  const declaredLength = req.headers['content-length'];
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY)) {
    req.resume();
    return Promise.reject(new HttpError(413, 'Request exceeds the 10 MB limit.', 'body_too_large'));
  }
  return new Promise((resolveBody, reject) => {
    let size = 0, chunks = [], settled = false;
    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('aborted', onAborted);
      req.removeListener('error', onError);
      chunks = [];
      if (err) { req.resume(); reject(err); } else resolveBody(result);
    };
    const onData = chunk => {
      size += chunk.length;
      if (size > MAX_BODY) finish(new HttpError(413, 'Request exceeds the 10 MB limit.', 'body_too_large'));
      else chunks.push(chunk);
    };
    const onEnd = () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        finish(null, body);
      } catch { finish(new HttpError(400, 'Request body must be a JSON object.')); }
    };
    const onAborted = () => finish(new HttpError(400, 'Request was interrupted.'));
    const onError = () => finish(new HttpError(400, 'Request could not be read.'));
    req.on('data', onData).on('end', onEnd).on('aborted', onAborted).on('error', onError);
  });
}

function inspectImage(bytes) {
  let format = null, width = 0, height = 0;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    format = { mime: 'image/png', extension: 'png' };
    if (bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid image header.');
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    format = { mime: 'image/jpeg', extension: 'jpg' };
    let at = 2;
    while (at + 4 <= bytes.length) {
      if (bytes[at] !== 0xff) break;
      while (bytes[at] === 0xff) at++;
      const marker = bytes[at++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (at + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(at);
      if (length < 2 || at + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) break;
        height = bytes.readUInt16BE(at + 3); width = bytes.readUInt16BE(at + 5); break;
      }
      at += length;
    }
  } else if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    format = { mime: 'image/webp', extension: 'webp' };
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3);
    } else if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff;
    } else if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
    }
  }
  if (!format || !width || !height || width > 10000 || height > 10000 || width * height > 40_000_000) {
    throw new Error('Image must be a valid PNG, JPEG, or WebP up to 40 megapixels and 10000 pixels per side.');
  }
  return { ...format, width, height, bytes: bytes.length };
}

function uploadImage(dataUrl) {
  if (typeof dataUrl !== 'string') throw new HttpError(400, 'roomDataUrl must be a base64 image.');
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[2].length % 4 !== 0) throw new HttpError(400, 'Upload a PNG, JPEG, or WebP base64 data URL.');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > MAX_UPLOAD_BYTES) throw new HttpError(413, 'Photo exceeds the 7 MB decoded image limit.', 'image_too_large');
  if (bytes.toString('base64') !== match[2]) throw new HttpError(400, 'Invalid image base64.');
  let meta;
  try { meta = inspectImage(bytes); }
  catch (err) { throw new HttpError(400, err.message); }
  if (meta.mime !== match[1]) throw new HttpError(400, 'Image content does not match its declared type.');
  return { bytes, dataUrl, meta };
}

function validateSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'settings must be an object.');
  if (Object.keys(value).some(key => !Object.hasOwn(DEFAULT_SETTINGS, key))) throw new HttpError(400, 'Unknown settings field.');
  const result = { ...DEFAULT_SETTINGS, ...value };
  if (typeof result.groutColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(result.groutColor)) throw new HttpError(400, 'groutColor must be a six-digit hex colour.');
  if (typeof result.groutMm !== 'number' || !Number.isFinite(result.groutMm) || result.groutMm < 0 || result.groutMm > 12) throw new HttpError(400, 'groutMm must be between 0 and 12.');
  if (![0, 90].includes(result.rotation)) throw new HttpError(400, 'rotation must be 0 or 90.');
  if (!['straight', 'offset'].includes(result.layout)) throw new HttpError(400, 'layout must be straight or offset.');
  if (typeof result.scale !== 'number' || !Number.isFinite(result.scale) || result.scale < 0.4 || result.scale > 2.5) throw new HttpError(400, 'scale must be between 0.4 and 2.5.');
  result.groutColor = result.groutColor.toLowerCase();
  return result;
}

function validateQuad(value) {
  if (!Array.isArray(value) || value.length !== 4 || value.some(p => !Array.isArray(p) || p.length !== 2 || p.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < -2 || n > 3))) {
    throw new HttpError(400, 'quad must contain four [x,y] points in image-relative coordinates, within -2 to 3.');
  }
  const crosses = value.map((a, i) => {
    const b = value[(i + 1) % 4], c = value[(i + 2) % 4];
    return (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
  });
  if (crosses.some(n => n < 1e-7)) {
    throw new HttpError(400, 'quad must be convex and clockwise in top-left, top-right, bottom-right, bottom-left order.');
  }
  return value.map(p => [...p]);
}

function validateExclusions(value = []) {
  if (!Array.isArray(value) || value.length > 12) throw new HttpError(400, 'Each surface supports at most 12 protection polygons.');
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const onSegment = (a, b, p) => Math.abs(cross(a, b, p)) < 1e-10 && p[0] >= Math.min(a[0], b[0]) - 1e-10 && p[0] <= Math.max(a[0], b[0]) + 1e-10 && p[1] >= Math.min(a[1], b[1]) - 1e-10 && p[1] <= Math.max(a[1], b[1]) + 1e-10;
  const intersects = (a, b, c, d) => {
    const ab1 = cross(a, b, c), ab2 = cross(a, b, d), cd1 = cross(c, d, a), cd2 = cross(c, d, b);
    return (ab1 * ab2 < 0 && cd1 * cd2 < 0) || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
  };
  return value.map(polygon => {
    if (!Array.isArray(polygon) || polygon.length < 3 || polygon.length > 32 || polygon.some(p => !Array.isArray(p) || p.length !== 2 || p.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < -2 || n > 3))) {
      throw new HttpError(400, 'Protection polygons need 3–32 finite image-relative points within -2 to 3.');
    }
    let area = 0;
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-7) throw new HttpError(400, 'Protection polygon has a repeated adjacent point.');
      area += a[0] * b[1] - b[0] * a[1];
      for (let j = i + 1; j < polygon.length; j++) {
        if (j === i + 1 || (i === 0 && j === polygon.length - 1)) continue;
        if (intersects(a, b, polygon[j], polygon[(j + 1) % polygon.length])) throw new HttpError(400, 'Protection polygons must not self-intersect.');
      }
    }
    if (Math.abs(area) < 1e-7) throw new HttpError(400, 'Protection polygon has no usable area.');
    return polygon.map(p => [...p]);
  });
}

function validateSurfaces(value, tiles) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) throw new HttpError(400, 'Select between 1 and 4 surfaces.');
  const ids = new Set(), tileIds = new Set(tiles.map(tile => tile.id));
  const allowed = ['id', 'label', 'kind', 'tileId', 'quad', 'exclusions', 'settings', 'planeWidthMm', 'planeDepthMm'];
  return value.map(surface => {
    if (!surface || typeof surface !== 'object' || Array.isArray(surface) || Object.keys(surface).some(key => !allowed.includes(key))) throw new HttpError(400, 'Invalid or unknown surface field.');
    if (typeof surface.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(surface.id) || ids.has(surface.id)) throw new HttpError(400, 'Surface IDs must be unique ASCII letters, digits, underscores or hyphens, 1–40 characters.');
    ids.add(surface.id);
    if (typeof surface.label !== 'string' || !surface.label.trim() || surface.label.length > 40 || /[\x00-\x1f\x7f]/.test(surface.label)) throw new HttpError(400, 'Each surface label must contain 1–40 printable characters.');
    if (!['floor', 'wall', 'splashback'].includes(surface.kind)) throw new HttpError(400, 'Surface kind must be floor, wall or splashback.');
    if (typeof surface.tileId !== 'string' || !tileIds.has(surface.tileId)) throw new HttpError(400, 'Unknown surface tileId.');
    const planeWidthMm = surface.planeWidthMm === undefined ? (surface.kind === 'floor' ? 4200 : 3600) : surface.planeWidthMm;
    const planeDepthMm = surface.planeDepthMm === undefined ? (surface.kind === 'floor' ? 4000 : 2600) : surface.planeDepthMm;
    if ([planeWidthMm, planeDepthMm].some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 100 || n > 30000)) throw new HttpError(400, 'Visual plane dimensions must be between 100 and 30000 mm.');
    return { id: surface.id, label: surface.label.trim(), kind: surface.kind, tileId: surface.tileId,
      quad: validateQuad(surface.quad), exclusions: validateExclusions(surface.exclusions), settings: validateSettings(surface.settings), planeWidthMm, planeDepthMm };
  });
}

async function catalog() {
  const data = JSON.parse(await readFile(join(ROOT, 'catalog.json'), 'utf8'));
  if (!Array.isArray(data.rooms) || !Array.isArray(data.tiles) || !Array.isArray(data.examples)) throw new Error('Invalid catalog.');
  return data;
}

async function validateInput(body) {
  const allowed = ['roomId', 'roomDataUrl', 'surfaces', 'clientRequestId'];
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new HttpError(400, 'Unknown request field.');
  if (body.clientRequestId !== undefined && (typeof body.clientRequestId !== 'string' || !UUID.test(body.clientRequestId))) throw new HttpError(400, 'clientRequestId must be a UUID.');
  if (typeof body.roomId !== 'string' || body.roomId.length > 80) throw new HttpError(400, 'A valid roomId is required.');
  const data = await catalog();
  let room = data.rooms.find(item => item.id === body.roomId);
  const surfaces = validateSurfaces(body.surfaces, data.tiles);
  const upload = body.roomDataUrl === undefined ? null : uploadImage(body.roomDataUrl);
  if (upload) {
    if (!/^upload-[A-Za-z0-9_-]{1,64}$/.test(body.roomId)) throw new HttpError(400, 'Uploaded rooms require an upload- identifier.');
    room = {
      id: body.roomId, name: 'Uploaded room', width: upload.meta.width, height: upload.meta.height,
      synthetic: false,
      sourceNote: 'Uploaded photo. Floor-plane dimensions are visual test assumptions, not customer measurements.',
    };
  } else if (!room || body.roomId.startsWith('upload-')) throw new HttpError(400, 'Unknown roomId, or uploaded room image bytes are missing.');
  return { room, surfaces, tiles: data.tiles, upload };
}

async function catalogImage(item) {
  if (typeof item.src !== 'string' || !item.src.startsWith('/assets/') || item.src.includes('?') || item.src.includes('#')) throw new Error('Invalid catalog asset.');
  const path = await publicFile(safePath(item.src));
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error('Invalid catalog image.');
  let bytes = await readFile(path);
  if (extname(path).toLowerCase() === '.svg') bytes = await requireSharp()(bytes, { limitInputPixels: 40_000_000 }).png().toBuffer();
  const meta = inspectImage(bytes);
  return { bytes, dataUrl: `data:${meta.mime};base64,${bytes.toString('base64')}`, meta };
}

function jobView(job) {
  const elapsedMs = job.apiElapsedMs ?? job.totalJobWallElapsedMs ?? (typeof job.startedAt === 'number' ? Math.round(performance.now() - job.startedAt) : 0);
  return {
    id: job.id, status: job.status, elapsedMs, phase: job.phase,
    ...(job.clientRequestId ? { clientRequestId: job.clientRequestId } : {}),
    executionState: job.executionState || (job.status === 'done' ? 'output_received' : 'uncertain'),
    elapsedBasis: job.apiElapsedMs === undefined ? 'job_wall_elapsed' : 'proxy_request_elapsed',
    ...(job.resultUrl ? { resultUrl: job.resultUrl } : {}),
    ...(job.originalResultUrl ? { originalResultUrl: job.originalResultUrl, displayImage: job.displayImage } : {}),
    ...(job.guideUrl ? { guideUrl: job.guideUrl, guideImage: job.guideImage } : {}),
    surfaces: job.surfaces,
    ...(job.inputImage ? { inputImage: job.inputImage } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(job.errorCode ? { errorCode: job.errorCode } : {}),
    ...(job.recovery ? { recovery: job.recovery } : {}),
    ...(job.providerHttpStatus ? { providerHttpStatus: job.providerHttpStatus } : {}),
    ...(job.warning ? { warning: job.warning, warningCode: job.warningCode } : {}),
    model: job.responseModel || null, requestedModel: job.requestedModel || null,
    requestedImageModel: job.requestedImageModel || null, responseImageModel: job.responseImageModel || null,
    ...(job.outputImage ? { outputImage: job.outputImage, inputImage: job.inputImage, outputAtMs: job.outputAtMs, responseCompleted: job.responseCompleted } : {}),
  };
}

async function persistJob(job) {
  const record = {
    id: job.id, status: job.status, phase: job.phase, createdAt: job.createdAt,
    clientRequestId: job.clientRequestId || null, requestFingerprint: job.requestFingerprint || null,
    executionState: job.executionState || 'not_started',
    providerStartedAt: job.providerStartedAt || null, cancelRequestedAt: job.cancelRequestedAt || null,
    ...(job.recoveredAt ? { recoveredAt: job.recoveredAt, previousStatus: job.previousStatus } : {}),
    startedAt: job.startedAtIso || null, finishedAt: job.finishedAt || null,
    roomId: job.roomId, roomSource: job.roomSource, surfaces: job.surfaces,
    surfaceInputSHA256: job.surfaceInputSHA256,
    sourceImage: job.sourceImage || null, inputSHA256: job.inputSHA256 || null,
    referencePlan: job.referencePlan || null,
    promptSHA256: job.promptSHA256 || null, promptText: job.promptText || null,
    requestedModel: job.requestedModel || null, responseModel: job.responseModel || null,
    requestedImageModel: job.requestedImageModel || null, responseImageModel: job.responseImageModel || null,
    proxyRequestElapsedMs: job.apiElapsedMs ?? null, proxyImageOutputAtMs: job.outputAtMs ?? null,
    totalJobWallElapsedMs: job.totalJobWallElapsedMs ?? null,
    responseCompleted: job.responseCompleted ?? null, phases: job.phases,
    inputImage: job.inputImage || null, tileImages: job.tileImages || [], outputImage: job.outputImage || null,
    guideUrl: job.guideUrl || null, guideImage: job.guideImage || null, guideProcessingMs: job.guideProcessingMs ?? null,
    resultUrl: job.resultUrl || null, error: job.error || null,
    errorCode: job.errorCode || null, recovery: job.recovery || null, providerHttpStatus: job.providerHttpStatus || null,
    warning: job.warning || null, warningCode: job.warningCode || null,
    originalResultUrl: job.originalResultUrl || null, displayImage: job.displayImage || null, previewProcessingMs: job.previewProcessingMs ?? null,
    privacy: 'Original upload bytes, base64 input, credentials, and request payload are not stored in this metadata or public source assets. The coloured guide is a retained local experiment artifact and contains the room.',
  };
  await jobStore.save(record);
}

async function runJob(job, input) {
  let stage = 'preparing_input';
  try {
    if (job.controller.signal.aborted) throw recoveryError('cancelled', { executionState: 'not_started' });
    job.status = 'running'; job.phase = 'loading_references';
    job.startedAt = performance.now(); job.startedAtIso = new Date().toISOString();
    const referencePlan = createReferencePlan({ surfaces: input.surfaces, tiles: input.tiles });
    const [sourceRoom, ...tileImages] = await Promise.all([input.upload || catalogImage(input.room), ...referencePlan.materials.map(material => catalogImage(material.tile))]);
    const prepared = await prepareRoomImage(sourceRoom.bytes);
    if (prepared.bytes.length > MAX_IMAGE_BYTES) throw new Error('Prepared room exceeded pilot limit');
    const roomImage = { bytes: prepared.bytes, meta: inspectImage(prepared.bytes) };
    roomImage.dataUrl = `data:${roomImage.meta.mime};base64,${roomImage.bytes.toString('base64')}`;
    job.inputSHA256 = sha256(sourceRoom.bytes);
    job.sourceImage = { ...sourceRoom.meta, sha256: job.inputSHA256 };
    job.inputImage = { ...roomImage.meta, sha256: sha256(roomImage.bytes), orientationNormalised: prepared.orientationNormalised };
    job.tileImages = tileImages.map((image, index) => ({ tileId: referencePlan.materials[index].tileId, imageIndex: referencePlan.materials[index].imageIndex, ...image.meta, sha256: sha256(image.bytes) }));
    job.referencePlan = { originalImageIndex: 1, guideImageIndex: 2, faces: referencePlan.faces, materials: referencePlan.materials.map(({ tileId, imageIndex, tile }) => ({ tileId, imageIndex, sku: tile.sku, widthMm: tile.widthMm, heightMm: tile.heightMm })) };
    if (job.controller.signal.aborted) throw recoveryError('cancelled', { executionState: 'not_started' });
    job.phase = 'building_guide';
    const guide = await createGuideImage({ roomBytes: roomImage.bytes, surfaces: input.surfaces, referencePlan });
    if (guide.bytes.length > MAX_IMAGE_BYTES) throw new Error('Guide image exceeded pilot limit');
    if (job.controller.signal.aborted) throw recoveryError('cancelled', { executionState: 'not_started' });
    await writeFile(join(PUBLIC, 'guides', `${job.id}.png`), guide.bytes);
    job.guideUrl = `/guides/${job.id}.png`;
    job.guideImage = { ...inspectImage(guide.bytes), sha256: guide.sha256, assignments: guide.assignments };
    job.guideProcessingMs = guide.processingMs;
    const prompt = buildTilePrompt({ ...input, referencePlan, room: { ...input.room, width: roomImage.meta.width, height: roomImage.meta.height } });
    job.promptSHA256 = sha256(prompt); job.promptText = prompt;
    stage = 'recording_request';
    await persistJob(job);
    if (job.controller.signal.aborted) throw recoveryError('cancelled', { executionState: 'not_started' });
    // Persist the execution boundary before the provider is invoked. A restart must
    // never interpret an accepted request as permission to send it again.
    job.providerStartedAt = new Date().toISOString(); job.executionState = 'started';
    job.phase = 'request_sent';
    await persistJob(job);
    stage = 'provider';
    const apiStartedAt = performance.now();
    const result = await generateImage({
      content: [
        { type: 'input_image', image_url: roomImage.dataUrl },
        { type: 'input_image', image_url: `data:image/png;base64,${guide.bytes.toString('base64')}` },
        ...tileImages.map(image => ({ type: 'input_image', image_url: image.dataUrl })),
        { type: 'input_text', text: prompt },
      ],
      workDir: TEMP, signal: job.controller.signal,
      onPhase: phase => {
        if (!job.controller.signal.aborted) { job.phase = phase; job.phases.push({ phase, elapsedMs: Math.round(performance.now() - apiStartedAt) }); }
      },
    });
    // A cancellation cannot discard a final image that already arrived.
    stage = 'validating_result'; job.executionState = 'output_received';
    if (result.bytes.length > MAX_IMAGE_BYTES) throw recoveryError('invalid_image');
    try {
      job.outputImage = { ...inspectImage(result.bytes), sha256: sha256(result.bytes) };
      // Header inspection alone accepts truncated files. Decode the full original.
      await requireSharp()(result.bytes, { limitInputPixels: 40_000_000 }).stats();
    } catch { throw recoveryError('invalid_image'); }
    job.apiElapsedMs = result.elapsedMs;
    job.outputAtMs = result.outputAtMs;
    job.responseModel = result.responseModel;
    job.responseImageModel = result.responseImageModel;
    job.responseCompleted = result.responseCompleted;
    job.phases = result.phases;
    if (result.warning) { job.warning = result.warning; job.warningCode = result.warningCode; }
    const fileName = `${job.id}.${job.outputImage.extension}`;
    stage = 'saving_original';
    await atomicWrite(join(PUBLIC, 'generated', fileName), result.bytes);
    job.resultUrl = '/generated/' + fileName;
    job.originalResultUrl = job.resultUrl;
    job.displayImage = job.outputImage;
    job.phase = 'preparing_result'; stage = 'recording_result';
    await persistJob(job);
    try {
      const display = await webPreview(result.bytes);
      const displayImage = { ...inspectImage(display.bytes), sha256: sha256(display.bytes) };
      if (display.converted) {
        await atomicWrite(join(PUBLIC, 'generated', `${job.id}-preview.webp`), display.bytes);
        job.resultUrl = `/generated/${job.id}-preview.webp`;
      }
      job.displayImage = displayImage;
      job.previewProcessingMs = Math.round(display.processingMs);
      if (!display.converted && /unavailable/i.test(display.reason || '')) throw recoveryError('result_processing');
    } catch {
      job.resultUrl = job.originalResultUrl; job.displayImage = job.outputImage;
      job.warning = 'The smaller preview could not be prepared. Your original AI image is saved and ready to use.';
      job.warningCode = 'preview_unavailable';
    }
    if (job.cancelRequestedAt && !job.warning) {
      job.warning = 'The final image arrived before cancellation finished. It has been saved.';
      job.warningCode = 'completed_before_cancel';
    }
    job.status = 'done'; job.phase = 'complete';
  } catch (err) {
    if (job.originalResultUrl) {
      job.status = 'done'; job.phase = 'complete';
      job.resultUrl = job.originalResultUrl; job.displayImage = job.outputImage;
      job.warning = 'Your original AI image is saved. Some local completion details could not be recorded; keep the saved result.';
      job.warningCode = 'result_metadata_unavailable';
    } else {
      let failure;
      if (err instanceof RecoveryError) failure = err;
      else if (job.controller.signal.aborted) failure = recoveryError('cancelled', { executionState: job.providerStartedAt ? 'uncertain' : 'not_started' });
      else if (stage === 'saving_original') failure = recoveryError('result_storage');
      else if (stage === 'validating_result') failure = recoveryError('invalid_image');
      else if (stage === 'recording_request') failure = recoveryError('request_storage', { executionState: 'not_started' });
      else if (stage === 'provider') failure = recoveryError('network_disconnected');
      else failure = recoveryError('local_processing');
      job.status = failure.errorCode === 'cancelled' ? 'cancelled' : 'failed'; job.phase = job.status;
      Object.assign(job, errorPayload(failure)); job.executionState = failure.recovery.executionState;
    }
  } finally {
    input.upload = null;
    job.finishedAt = new Date().toISOString();
    job.totalJobWallElapsedMs = job.startedAt ? Math.round(performance.now() - job.startedAt) : 0;
    try { await persistJob(job); }
    catch { job.warning = 'Completion details could not be saved locally. Keep this job ID and any saved result.'; job.warningCode = 'result_metadata_unavailable'; console.error(`Job ${job.id}: metadata could not be saved.`); }
    if (activeJobId === job.id) activeJobId = null;
  }
}

function pruneJobs() {
  if (jobs.size < 150) return;
  for (const [id, job] of jobs) {
    if (['done', 'failed', 'cancelled'].includes(job.status) && id !== activeJobId) jobs.delete(id);
    if (jobs.size < 100) break;
  }
}

function restoreJob(record) {
  const legacyError = ['failed', 'cancelled'].includes(record.status) && !record.errorCode
    ? errorPayload(recoveryError(record.status === 'cancelled' ? 'cancelled' : 'provider_error', { executionState: 'uncertain' })) : {};
  return { ...record, ...legacyError, startedAtIso: record.startedAt || null, startedAt: undefined,
    apiElapsedMs: record.proxyRequestElapsedMs ?? undefined,
    outputAtMs: record.proxyImageOutputAtMs ?? undefined,
    phases: record.phases || [], controller: null };
}

async function findJob(id) {
  if (jobs.has(id)) return jobs.get(id);
  const record = await jobStore.load(id);
  if (!record) return null;
  const job = restoreJob(record);
  pruneJobs(); jobs.set(id, job);
  return job;
}

function acceptRequest(body) {
  const operation = accepting.catch(() => {}).then(async () => {
    if (body.clientRequestId !== undefined && (typeof body.clientRequestId !== 'string' || !UUID.test(body.clientRequestId))) throw new HttpError(400, 'clientRequestId must be a UUID.');
    const clientRequestId = body.clientRequestId?.toLowerCase() || null;
    const fingerprint = requestFingerprint(body);
    const existing = clientRequestId && jobStore.requests.get(clientRequestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw Object.assign(recoveryError('request_conflict'), { status: 409 });
      const job = await findJob(existing.jobId);
      if (!job) throw Object.assign(recoveryError('history_unavailable'), { status: 503 });
      return { job, duplicate: true };
    }
    if (jobStore.unreadable) throw Object.assign(recoveryError('history_unavailable'), { status: 503 });
    if (shuttingDown) throw Object.assign(recoveryError('local_busy'), { status: 503 });
    if (!providerHealth().configured) throw Object.assign(recoveryError('not_configured'), { status: 503 });
    const input = await validateInput(body);
    // The durable identity lookup deliberately precedes the busy gate.
    if (activeJobId) throw Object.assign(recoveryError('local_busy'), { status: 429 });
    pruneJobs();
    const id = randomUUID();
    const job = {
      id, clientRequestId, requestFingerprint: fingerprint, executionState: 'not_started',
      requestedModel: MODEL, requestedImageModel: IMAGE_MODEL,
      status: 'queued', phase: 'queued', createdAt: new Date().toISOString(),
      roomId: input.room.id, roomSource: input.upload ? 'user_upload' : 'catalog',
      surfaces: input.surfaces, surfaceInputSHA256: sha256(JSON.stringify(input.surfaces)), controller: new AbortController(), phases: [],
    };
    activeJobId = id; jobs.set(id, job);
    try { await persistJob(job); }
    catch {
      activeJobId = null; jobs.delete(id);
      throw Object.assign(recoveryError('request_storage'), { status: 503 });
    }
    // Start exactly once after the acceptance record is durable. A disconnected
    // caller may lose its receipt, but that cannot roll back or repeat this job.
    const running = runJob(job, input);
    runningJobs.set(job.id, running);
    void running.finally(() => runningJobs.delete(job.id));
    return { job, duplicate: false };
  });
  accepting = operation;
  return operation;
}

async function serveStatic(req, res, pathname) {
  if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'Method not allowed.', 'method_not_allowed');
  const file = await publicFile(pathname === '/' ? '/index.html' : pathname);
  const info = await stat(file);
  if (!info.isFile()) throw new HttpError(404, 'File not found.', 'not_found');
  const etag = `W/"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': mimeTypes[extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': /\.(?:png|jpe?g|webp|avif|woff2?)$/i.test(file) ? 'public, max-age=60' : 'no-cache',
    'ETag': etag, 'Last-Modified': info.mtime.toUTCString(),
  };
  if (req.headers['if-none-match'] === etag) {
    delete headers['Content-Length']; res.writeHead(304, headers); res.end(); return;
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  const stream = createReadStream(file);
  stream.on('error', () => res.destroy()); stream.pipe(res);
}

await mkdir(join(PUBLIC, 'generated'), { recursive: true });
await mkdir(join(PUBLIC, 'guides'), { recursive: true });
await mkdir(JOB_EVIDENCE, { recursive: true });
await mkdir(TEMP, { recursive: true });

// An extra process must not mark a live process's jobs interrupted.
const runtimeLockPath = join(JOB_EVIDENCE, 'runtime.lock');
const runtimeToken = randomUUID();
async function claimRuntime() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(runtimeLockPath, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token: runtimeToken })); await handle.sync(); }
      finally { await handle.close(); }
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw new Error('The local editor could not reserve its request history.');
      let previous;
      try { previous = JSON.parse(await readFile(runtimeLockPath, 'utf8')); }
      catch { throw new Error('The local editor request-history lock needs checking.'); }
      if (!Number.isInteger(previous.pid) || previous.pid < 1) throw new Error('The local editor request-history lock needs checking.');
      let alive = true;
      try { process.kill(previous.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('This editor directory is already running. Use a separate candidate directory.');
      // Remove only the dead process lock we actually inspected.
      const current = JSON.parse(await readFile(runtimeLockPath, 'utf8'));
      if (current.token !== previous.token) throw new Error('Another editor process is starting.');
      await unlink(runtimeLockPath);
    }
  }
  throw new Error('The local editor could not reserve its request history.');
}
async function releaseRuntime() {
  try {
    const current = JSON.parse(await readFile(runtimeLockPath, 'utf8'));
    if (current.token === runtimeToken) await unlink(runtimeLockPath);
  } catch {}
}
await claimRuntime();
// A crashed process may leave a private request file. Never retain its photo payload.
for (const name of await readdir(TEMP)) {
  if (/^[0-9a-f-]{36}\.(?:request\.json|response\.headers)$/i.test(name)) await unlink(join(TEMP, name)).catch(() => {});
}
for (const record of await jobStore.initialise()) {
  const job = restoreJob(record);
  if (job.errorCode === 'interrupted' && job.originalResultUrl && job.outputImage?.sha256) {
    try {
      const bytes = await readFile(await publicFile(safePath(job.originalResultUrl)));
      if (sha256(bytes) === job.outputImage.sha256) {
        job.status = 'done'; job.phase = 'complete'; job.executionState = 'output_received';
        job.resultUrl = job.originalResultUrl; job.displayImage = job.outputImage;
        delete job.error; delete job.errorCode; delete job.recovery;
        job.warning = 'Your saved original AI image was recovered after the server restarted.';
        job.warningCode = 'saved_original_recovered';
        await persistJob(job);
      }
    } catch { /* Keep the durable interrupted record and never regenerate. */ }
  }
  jobs.set(job.id, job);
}
pruneJobs();

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  try {
    const host = req.headers.host;
    if (![`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(host)) throw new HttpError(403, 'Unrecognised local host.', 'forbidden');
    if (req.method === 'POST' && req.headers.origin !== `http://${host}`) {
      req.resume(); throw new HttpError(403, 'POST requests must originate from this local pilot.', 'forbidden');
    }
    const pathname = safePath(req.url);
    if (pathname === '/api/catalog') {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.', 'method_not_allowed');
      json(res, 200, await catalog()); return;
    }
    if (pathname === '/api/health') {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.', 'method_not_allowed');
      json(res, 200, providerHealth()); return;
    }
    if (pathname === '/api/validate') {
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.', 'method_not_allowed');
      const input = await validateInput(await readJson(req));
      json(res, 200, { valid: true, roomId: input.room.id, surfaces: input.surfaces }); return;
    }
    if (pathname === '/api/generate') {
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.', 'method_not_allowed');
      const { job, duplicate } = await acceptRequest(await readJson(req));
      json(res, 202, { jobId: job.id, ...jobView(job), duplicate });
      return;
    }
    const requestRoute = /^\/api\/requests\/([0-9a-f-]{36})$/i.exec(pathname);
    if (requestRoute && UUID.test(requestRoute[1])) {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.', 'method_not_allowed');
      // Wait for a concurrently accepted POST to finish its durable receipt.
      await accepting.catch(() => {});
      const receipt = jobStore.requests.get(requestRoute[1].toLowerCase());
      if (!receipt) throw Object.assign(recoveryError(jobStore.unreadable ? 'history_unavailable' : 'request_not_found'), { status: jobStore.unreadable ? 503 : 404 });
      const job = await findJob(receipt.jobId);
      if (!job) throw Object.assign(recoveryError('history_unavailable'), { status: 503 });
      json(res, 200, { jobId: job.id, ...jobView(job) }); return;
    }
    const jobRoute = /^\/api\/jobs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/cancel)?$/.exec(pathname);
    if (jobRoute) {
      const job = await findJob(jobRoute[1]);
      if (!job) throw Object.assign(recoveryError('job_not_found'), { status: 404 });
      if (jobRoute[2]) {
        if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.', 'method_not_allowed');
        req.resume();
        if (['queued', 'running'].includes(job.status)) {
          job.cancelRequestedAt = new Date().toISOString();
          job.phase = 'cancelling';
          job.controller?.abort();
          await persistJob(job);
        }
      } else if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.', 'method_not_allowed');
      json(res, 200, jobView(job)); return;
    }
    if (pathname.startsWith('/api/')) throw new HttpError(404, 'API endpoint not found.', 'not_found');
    await serveStatic(req, res, pathname);
  } catch (err) {
    if (res.headersSent) { res.destroy(); return; }
    if (err instanceof RecoveryError) {
      const retryAfterMs = err.recovery.retryAfterMs;
      json(res, err.status || 503, { ...errorPayload(err), code: err.errorCode === 'local_busy' ? 'busy' : err.errorCode }, retryAfterMs === null ? {} : { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) });
    } else if (err instanceof HttpError) {
      const failure = recoveryError('invalid_input');
      json(res, err.status, { ...errorPayload(failure), error: err.message, code: err.code }, err.status === 413 ? { Connection: 'close' } : {});
    } else { json(res, 500, { ...errorPayload(recoveryError('history_unavailable')), code: 'internal_error' }); console.error('A local pilot request failed.'); }
  }
});

server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.on('error', err => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Stop the existing pilot before starting another.` : 'The local pilot server could not start.');
  process.exitCode = 1;
  void releaseRuntime();
});
server.listen(PORT, HOST, () => console.log(`Tile visualizer multi-surface pilot: http://${HOST}:${PORT}\nLocal only. Press Ctrl+C to stop.`));

function stop() {
  shuttingDown = true;
  for (const job of jobs.values()) if (['queued', 'running'].includes(job.status)) job.controller?.abort();
  server.close(() => { void Promise.allSettled([...runningJobs.values()]).then(releaseRuntime); });
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);


