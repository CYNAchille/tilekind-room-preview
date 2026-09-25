// Keep backend image-coordinate winding consistent without restricting drawing direction.
// The first chosen corner stays the first corner; no point is moved or clamped.
export function normalizeQuadWinding(points) {
  if (!Array.isArray(points) || points.length !== 4) return null;
  if (points.some(point => !Array.isArray(point) || point.length !== 2 || point.some(value => typeof value !== 'number' || !Number.isFinite(value)))) return null;
  const quad = points.map(point => [...point]);
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  let area = 0;
  const turns = [];
  for (let i = 0; i < 4; i++) {
    const a = quad[i], b = quad[(i + 1) % 4];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.0001) return null;
    area += a[0] * b[1] - b[0] * a[1];
    turns.push(cross(a, b, quad[(i + 2) % 4]));
  }
  if (Math.abs(area) <= 0.00002) return null;
  const clockwise = turns.every(turn => turn > 0.000001);
  const counterclockwise = turns.every(turn => turn < -0.000001);
  if (!clockwise && !counterclockwise) return null;
  return clockwise ? quad : [quad[0], quad[3], quad[2], quad[1]];
}
