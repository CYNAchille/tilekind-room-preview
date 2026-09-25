import { createHash } from 'node:crypto';
import { requireSharp } from './image-output.mjs';
import { SURFACE_MARKERS } from './build-prompt.mjs';

function pointInside(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if (((a[1] > point[1]) !== (b[1] > point[1])) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
const inSurface = (point, surface) => pointInside(point, surface.quad) && !surface.exclusions.some(hole => pointInside(point, hole));

function edgeDistance(point, polygons) {
  let result = Infinity;
  for (const polygon of polygons) for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    result = Math.min(result, Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy));
  }
  return result;
}

function labelPoint(surface, index, surfaces) {
  const later = surfaces.slice(index + 1);
  const frame = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const boundaries = [surface.quad, ...surface.exclusions, frame, ...later.flatMap(s => [s.quad, ...s.exclusions])];
  let best = null, bestDistance = -1;
  for (let y = 1; y < 80; y++) for (let x = 1; x < 100; x++) {
    const point = [x / 100, y / 80];
    if (!inSurface(point, surface) || later.some(s => inSurface(point, s))) continue;
    const distance = edgeDistance(point, boundaries);
    if (distance > bestDistance) { bestDistance = distance; best = point; }
  }
  return { point: best, clearance: Math.max(0, bestDistance) };
}

export async function createGuideImage({ roomBytes, surfaces, referencePlan }) {
  const started = performance.now(), sharp = requireSharp();
  const { width, height } = await sharp(roomBytes, { limitInputPixels: 40_000_000 }).metadata();
  if (!width || !height) throw new Error('Guide source dimensions unavailable.');
  const path = polygon => polygon.map((point, index) => `${index ? 'L' : 'M'}${(point[0] * width).toFixed(3)},${(point[1] * height).toFixed(3)}`).join(' ') + ' Z';
  const masks = [], fills = [], labels = [], assignments = [];
  for (const [index, surface] of surfaces.entries()) {
    masks.push(`<mask id="raw-face-${index}" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="black"/><path d="${path(surface.quad)}" fill="white"/>${surface.exclusions.map(hole => `<path d="${path(hole)}" fill="black"/>`).join('')}</mask>`);
  }
  for (const [index, surface] of surfaces.entries()) {
    const marker = referencePlan?.faces[index] || { ...SURFACE_MARKERS[index], surfaceId: surface.id };
    const maskId = `face-mask-${index}`;
    masks.push(`<mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="black"/><rect width="${width}" height="${height}" fill="white" mask="url(#raw-face-${index})"/>${surfaces.slice(index + 1).map((_, later) => `<rect width="${width}" height="${height}" fill="black" mask="url(#raw-face-${index + later + 1})"/>`).join('')}</mask>`);
    fills.push(`<g mask="url(#${maskId})"><rect width="${width}" height="${height}" fill="${marker.color}" fill-opacity="0.38"/><path d="${path(surface.quad)}" fill="none" stroke="${marker.color}" stroke-width="${Math.max(3, width / 380).toFixed(2)}"/></g>`);
    const placement = labelPoint(surface, index, surfaces);
    const radius = Math.max(10, Math.min(Math.min(width, height) * .025, placement.clearance * Math.min(width, height) * .65));
    if (placement.point) {
      const x = placement.point[0] * width, y = placement.point[1] * height;
      labels.push(`<g mask="url(#${maskId})"><circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius.toFixed(2)}" fill="${marker.color}" stroke="white" stroke-width="${Math.max(2, radius / 10).toFixed(2)}"/><text x="${x.toFixed(2)}" y="${(y + radius * .35).toFixed(2)}" text-anchor="middle" font-family="Arial, sans-serif" font-size="${(radius * 1.3).toFixed(2)}" font-weight="700" fill="white">${marker.letter}</text></g>`);
    }
    assignments.push({ surfaceId: surface.id, letter: marker.letter, color: marker.color, referenceImageIndex: marker.referenceImageIndex || null, labelPoint: placement.point, visibleLabel: Boolean(placement.point) });
  }
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${masks.join('')}</defs>${fills.join('')}${labels.join('')}</svg>`);
  const bytes = await sharp(roomBytes, { limitInputPixels: 40_000_000 }).composite([{ input: svg }]).png().toBuffer();
  return { bytes, mime: 'image/png', width, height, assignments,
    sha256: createHash('sha256').update(bytes).digest('hex'), processingMs: Math.round(performance.now() - started) };
}
