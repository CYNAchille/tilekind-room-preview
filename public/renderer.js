/* Local preview renderer. Geometry and tile dimensions are explicit inputs,
 * not measurements inferred from a photograph. No network requests are made. */

const MAX_SCENE_EDGE = 1536;
const MAX_TILE_EDGE = 1024;
const EPSILON = 1e-10;

function finite(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be a finite number.`);
  return number;
}

function positive(value, name) {
  const number = finite(value, name);
  if (number <= 0) throw new Error(`${name} must be greater than zero.`);
  return number;
}

function point(value, name) {
  const x = Array.isArray(value) ? value[0] : value?.x;
  const y = Array.isArray(value) ? value[1] : value?.y;
  return [finite(x, `${name}.x`), finite(y, `${name}.y`)];
}

/** Validate a convex four-point boundary. Points may be outside the image. */
export function validateQuad(input) {
  if (!Array.isArray(input) || input.length !== 4) {
    throw new Error('The floor needs four corners: top left, top right, bottom right, bottom left.');
  }
  const quad = input.map((p, i) => point(p, `quad[${i}]`));
  const extent = Math.max(1, ...quad.flat().map(Math.abs));
  const tolerance = 1e-8 * extent * extent;
  let sign = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = quad[i], b = quad[(i + 1) % 4], c = quad[(i + 2) % 4];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < tolerance) throw new Error('Floor corners are too close or nearly collinear.');
    if (sign && Math.sign(cross) !== sign) throw new Error('Floor corners must form a convex shape without crossing.');
    sign = Math.sign(cross);
  }
  return quad;
}

function solveLinear(rows) {
  const size = rows.length;
  const matrix = rows.map(row => row.slice());
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row;
    }
    if (Math.abs(matrix[pivot][column]) < EPSILON) throw new Error('This floor perspective cannot be resolved. Move the corners farther apart.');
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    const divisor = matrix[column][column];
    for (let j = column; j <= size; j += 1) matrix[column][j] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const multiplier = matrix[row][column];
      for (let j = column; j <= size; j += 1) matrix[row][j] -= multiplier * matrix[column][j];
    }
  }
  return matrix.map(row => row[size]);
}

/** Row-major homography from unit floor coordinates to image coordinates. */
export function homographyForQuad(input) {
  const quad = validateQuad(input);
  const square = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const rows = [];
  square.forEach(([x, y], i) => {
    const [u, v] = quad[i];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  });
  return [...solveLinear(rows), 1];
}

export function invertHomography(matrix) {
  if (!Array.isArray(matrix) || matrix.length !== 9) throw new Error('A homography needs nine entries.');
  const [a, b, c, d, e, f, g, h, i] = matrix.map((v, n) => finite(v, `matrix[${n}]`));
  const cofactors = [e*i-f*h, c*h-b*i, b*f-c*e, f*g-d*i, a*i-c*g, c*d-a*f, d*h-e*g, b*g-a*h, a*e-b*d];
  const determinant = a * cofactors[0] + b * cofactors[3] + c * cofactors[6];
  if (Math.abs(determinant) < EPSILON) throw new Error('The selected floor perspective is degenerate.');
  return cofactors.map(value => value / determinant);
}

export function projectPoint(matrix, input) {
  const [x, y] = point(input, 'point');
  const denominator = matrix[6] * x + matrix[7] * y + matrix[8];
  if (Math.abs(denominator) < EPSILON) return null;
  return [(matrix[0] * x + matrix[1] * y + matrix[2]) / denominator,
    (matrix[3] * x + matrix[4] * y + matrix[5]) / denominator];
}

function columnMajor(matrix) {
  return new Float32Array([matrix[0], matrix[3], matrix[6], matrix[1], matrix[4], matrix[7], matrix[2], matrix[5], matrix[8]]);
}

function surface(width, height) {
  const result = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
  result.width = width;
  result.height = height;
  return result;
}

function context2d(canvas) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('A 2D canvas is needed to prepare the photo and masks.');
  return context;
}

function dimensions(image, name) {
  if (!image || image.complete === false) throw new Error(`${name} has not finished loading.`);
  const width = positive(image.naturalWidth || image.videoWidth || image.width, `${name} width`);
  const height = positive(image.naturalHeight || image.videoHeight || image.height, `${name} height`);
  return { width, height };
}

function polygonPath(context, polygon, width, height) {
  context.beginPath();
  polygon.forEach(([x, y], index) => {
    if (index === 0) context.moveTo(x * width, y * height);
    else context.lineTo(x * width, y * height);
  });
  context.closePath();
}

function insidePolygon([x, y], polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if (((yi > y) !== (yj > y)) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function rgb(hex) {
  if (typeof hex !== 'string' || !/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(hex)) {
    throw new Error('Grout colour must be a hex colour such as #d6d0c5.');
  }
  const expanded = hex.length === 4 ? hex.slice(1).split('').map(c => c + c).join('') : hex.slice(1);
  return [0, 2, 4].map(offset => parseInt(expanded.slice(offset, offset + 2), 16) / 255);
}

function shader(gl, type, source) {
  const result = gl.createShader(type);
  gl.shaderSource(result, source);
  gl.compileShader(result);
  if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
    const detail = gl.getShaderInfoLog(result);
    gl.deleteShader(result);
    throw new Error(`The graphics driver could not compile the tile renderer: ${detail}`);
  }
  return result;
}

const VERTEX = `
attribute vec2 aPosition;
varying vec2 vImage;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
  vImage = vec2(aPosition.x * 0.5 + 0.5, 0.5 - aPosition.y * 0.5);
}`;

function fragment(hasDerivatives, hasHighPrecision) {
  return `${hasDerivatives ? '#extension GL_OES_standard_derivatives : enable\n' : ''}
precision ${hasHighPrecision ? 'highp' : 'mediump'} float;
varying vec2 vImage;
uniform sampler2D uScene;
uniform sampler2D uTile;
uniform sampler2D uMask;
uniform sampler2D uLight;
uniform mat3 uImageToPlane;
uniform vec2 uPlaneMm;
uniform vec2 uTileMm;
uniform vec3 uGroutColor;
uniform float uGroutMm;
uniform float uRotation;
uniform float uBrick;
uniform float uShading;
uniform float uReferenceLight;
uniform float uMode;
void main() {
  vec4 original = texture2D(uScene, vImage);
  if (uMode > 0.5 && uMode < 1.5) { gl_FragColor = original; return; }
  vec3 projected = uImageToPlane * vec3(vImage, 1.0);
  if (abs(projected.z) < 0.000001) { if (uMode > 1.5) discard; gl_FragColor = original; return; }
  vec2 floorUV = projected.xy / projected.z;
  if (floorUV.x < 0.0 || floorUV.x > 1.0 || floorUV.y < 0.0 || floorUV.y > 1.0) {
    if (uMode > 1.5) discard; gl_FragColor = original; return;
  }
  float mask = texture2D(uMask, vImage).r;
  if (mask <= 0.0) { if (uMode > 1.5) discard; gl_FragColor = original; return; }
  // Dimensions use metres internally to keep mediump hardware numerically useful.
  vec2 plane = floorUV * uPlaneMm;
  vec2 tileSize = uTileMm;
  if (uRotation == 1.0 || uRotation == 3.0) tileSize = tileSize.yx;
  vec2 pitch = tileSize + vec2(uGroutMm);
  float row = floor(plane.y / pitch.y);
  vec2 shifted = plane + vec2(mod(row, 2.0) * uBrick * pitch.x * 0.5, 0.0);
  vec2 local = mod(shifted, pitch);
  float halfGap = uGroutMm * 0.5;
  vec2 tileUV = clamp((local - halfGap) / tileSize, 0.0, 1.0);
  vec2 edgeDistance = min(local - halfGap, tileSize + halfGap - local);
  ${hasDerivatives ? `vec2 footprint = max(fwidth(plane) * 0.6, vec2(0.000005));
  vec2 coverage = smoothstep(-footprint, footprint, edgeDistance);` : `vec2 coverage = step(vec2(0.0), edgeDistance);`}
  float tileCoverage = coverage.x * coverage.y;
  if (uGroutMm <= 0.0) tileCoverage = 1.0;
  if (uRotation == 1.0) tileUV = vec2(tileUV.y, 1.0 - tileUV.x);
  else if (uRotation == 2.0) tileUV = vec2(1.0 - tileUV.x, 1.0 - tileUV.y);
  else if (uRotation == 3.0) tileUV = vec2(1.0 - tileUV.y, tileUV.x);
  vec3 material = mix(uGroutColor, texture2D(uTile, tileUV).rgb, tileCoverage);
  float illumination = dot(texture2D(uLight, vImage).rgb, vec3(0.2126, 0.7152, 0.0722));
  float relativeLight = clamp(illumination / max(uReferenceLight, 0.04), 0.40, 1.45);
  float exposure = pow(mix(1.0, relativeLight, uShading), 2.2);
  vec3 linearMaterial = pow(material, vec3(2.2));
  if (exposure <= 1.0) {
    linearMaterial *= exposure;
  } else {
    // Reserve the remaining highlight headroom instead of clipping an ivory
    // tile to white. One shared multiplier preserves the material's RGB ratios.
    float peak = max(max(linearMaterial.r, linearMaterial.g), linearMaterial.b);
    float liftedPeak = peak + (1.0 - peak) * (1.0 - exp(-(exposure - 1.0) * peak));
    linearMaterial *= liftedPeak / max(peak, 0.00001);
  }
  material = pow(linearMaterial, vec3(1.0 / 2.2));
  if (uMode > 1.5) gl_FragColor = vec4(material, mask * original.a);
  else gl_FragColor = vec4(mix(original.rgb, material, mask), original.a);
}`;
}

export class TileRenderer {
  constructor(canvas) {
    if (!canvas?.getContext) throw new Error('TileRenderer needs a canvas element.');
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl', { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: false });
    if (!this.gl) throw new Error('WebGL is unavailable. Enable browser hardware acceleration or try a current browser.');
    this._destroyed = false;
    this._lost = false;
    this._scene = null;
    this._tile = null;
    this._readbackPixel = new Uint8Array(4);
    this._onLost = event => { event.preventDefault(); this._lost = true; };
    this._onRestored = () => {
      this._lost = false;
      this._scene = null;
      this._tile = null;
      this._createResources();
      // Callers can reload their current inputs after the browser restores WebGL.
      this.canvas.dispatchEvent(new Event('tilerendererrestore'));
    };
    canvas.addEventListener('webglcontextlost', this._onLost);
    canvas.addEventListener('webglcontextrestored', this._onRestored);
    this._createResources();
  }

  _assertReady() {
    if (this._destroyed) throw new Error('This tile renderer has been destroyed.');
    if (this._lost || this.gl.isContextLost()) throw new Error('The browser lost its graphics context. Reload the photo after graphics recovery.');
  }

  _createResources() {
    const gl = this.gl;
    const hasDerivatives = Boolean(gl.getExtension('OES_standard_derivatives'));
    const hasHighPrecision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)?.precision > 0;
    const vertex = shader(gl, gl.VERTEX_SHADER, VERTEX);
    let pixel;
    try { pixel = shader(gl, gl.FRAGMENT_SHADER, fragment(hasDerivatives, hasHighPrecision)); }
    catch (error) { gl.deleteShader(vertex); throw error; }
    this._program = gl.createProgram();
    gl.attachShader(this._program, vertex);
    gl.attachShader(this._program, pixel);
    gl.linkProgram(this._program);
    gl.deleteShader(vertex);
    gl.deleteShader(pixel);
    if (!gl.getProgramParameter(this._program, gl.LINK_STATUS)) {
      const detail = gl.getProgramInfoLog(this._program);
      gl.deleteProgram(this._program);
      throw new Error(`The graphics driver could not link the tile renderer: ${detail}`);
    }
    this._position = gl.getAttribLocation(this._program, 'aPosition');
    const names = ['uScene', 'uTile', 'uMask', 'uLight', 'uImageToPlane', 'uPlaneMm', 'uTileMm', 'uGroutColor', 'uGroutMm', 'uRotation', 'uBrick', 'uShading', 'uReferenceLight', 'uMode'];
    this._uniform = Object.fromEntries(names.map(name => [name, gl.getUniformLocation(this._program, name)]));
    this._buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this._textures = Array.from({ length: 4 }, () => gl.createTexture());
    this._anisotropy = gl.getExtension('EXT_texture_filter_anisotropic') || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
    this._maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this._hasDerivatives = hasDerivatives;
  }

  _upload(index, source, mipmaps = false) {
    this._uploadTexture(this._textures[index], index, source, mipmaps);
  }

  _uploadTexture(texture, index, source, mipmaps = false) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + index);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source); }
    catch (error) { throw new Error(`The image cannot be used for rendering. Use a local upload or an image with CORS permission. ${error.message}`); }
    if (mipmaps) {
      gl.generateMipmap(gl.TEXTURE_2D);
      if (this._anisotropy) {
        const maximum = gl.getParameter(this._anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
        gl.texParameterf(gl.TEXTURE_2D, this._anisotropy.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, maximum));
      }
    }
  }

  async setScene({ image, quad, exclusions = [], planeWidthMm = 4200, planeDepthMm = 4000 }) {
    this._assertReady();
    const validQuad = validateQuad(quad);
    const inverse = invertHomography(homographyForQuad(validQuad));
    const widthMm = positive(planeWidthMm, 'Floor width');
    const depthMm = positive(planeDepthMm, 'Floor depth');
    if (!Array.isArray(exclusions)) throw new Error('Exclusions must be a list of polygons.');
    const polygons = exclusions.map((polygon, index) => {
      if (!Array.isArray(polygon) || polygon.length < 3) throw new Error(`Exclusion ${index + 1} needs at least three points.`);
      return polygon.map((p, i) => point(p, `exclusions[${index}][${i}]`));
    });
    const size = dimensions(image, 'Room photo');
    const ratio = Math.min(1, Math.min(MAX_SCENE_EDGE, this._maxTextureSize) / Math.max(size.width, size.height));
    const width = Math.max(1, Math.round(size.width * ratio));
    const height = Math.max(1, Math.round(size.height * ratio));
    const sourceKey = image.currentSrc || image.src || '';
    const sameImage = this._scene?.image === image && this._scene.sourceKey === sourceKey && this._scene.width === width && this._scene.height === height;
    let lighting = this._scene?.lighting;
    let lightPixels = this._scene?.lightPixels;
    if (!sameImage) {
      const photo = surface(width, height);
      context2d(photo).drawImage(image, 0, 0, width, height);
      this._upload(0, photo);
      const lightRatio = Math.min(1, 256 / Math.max(width, height));
      lighting = surface(Math.max(1, Math.round(width * lightRatio)), Math.max(1, Math.round(height * lightRatio)));
      const lightContext = context2d(lighting);
      lightContext.filter = 'blur(5px)';
      lightContext.drawImage(photo, 0, 0, lighting.width, lighting.height);
      lightContext.filter = 'none';
      lightPixels = lightContext.getImageData(0, 0, lighting.width, lighting.height).data;
      this._upload(3, lighting);
    }
    const mask = surface(width, height);
    const maskContext = context2d(mask);
    maskContext.fillStyle = '#000';
    maskContext.fillRect(0, 0, width, height);
    maskContext.fillStyle = '#fff';
    polygonPath(maskContext, validQuad, width, height);
    maskContext.fill();
    maskContext.fillStyle = '#000';
    polygons.forEach(polygon => { polygonPath(maskContext, polygon, width, height); maskContext.fill(); });
    this._upload(2, mask);
    let lightTotal = 0, lightCount = 0;
    for (let y = 0; y < lighting.height; y += 3) {
      for (let x = 0; x < lighting.width; x += 3) {
        const sample = [(x + 0.5) / lighting.width, (y + 0.5) / lighting.height];
        if (!insidePolygon(sample, validQuad) || polygons.some(polygon => insidePolygon(sample, polygon))) continue;
        const offset = (y * lighting.width + x) * 4;
        lightTotal += (lightPixels[offset] * 0.2126 + lightPixels[offset + 1] * 0.7152 + lightPixels[offset + 2] * 0.0722) / 255;
        lightCount += 1;
      }
    }
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this._scene = { image, sourceKey, width, height, inverse, widthMm, depthMm, lighting, lightPixels,
      referenceLight: lightCount ? lightTotal / lightCount : 0.5 };
    return { width, height, sourceWidth: size.width, sourceHeight: size.height, sourceReused: Boolean(sameImage) };
  }

  async setTile({ image, widthMm = 600, heightMm = 600 }) {
    this._assertReady();
    const tileWidthMm = positive(widthMm, 'Tile width');
    const tileHeightMm = positive(heightMm, 'Tile height');
    const size = dimensions(image, 'Tile image');
    const sourceKey = image.currentSrc || image.src || '';
    const sameImage = this._tile?.image === image && this._tile.sourceKey === sourceKey;
    if (!sameImage) {
      const limit = Math.min(MAX_TILE_EDGE, this._maxTextureSize);
      const pot = value => Math.min(limit, 2 ** Math.ceil(Math.log2(Math.max(1, value))));
      const texture = surface(pot(size.width), pot(size.height));
      context2d(texture).drawImage(image, 0, 0, texture.width, texture.height);
      this._upload(1, texture, true);
    }
    this._tile = { image, sourceKey, widthMm: tileWidthMm, heightMm: tileHeightMm };
    return { widthMm: tileWidthMm, heightMm: tileHeightMm, sourceReused: Boolean(sameImage) };
  }

  /**
   * durationMs measures the draw plus a synchronous one-pixel readback, not FPS.
   * It excludes JavaScript photo/mask preparation in setScene/setTile, but the
   * first call can also wait for queued GPU texture uploads. It does not measure
   * browser compositing, display presentation, network latency, or AI generation.
   * Readback overhead is included; this is not a pure GPU execution-time query.
   */
  render(settings = {}) {
    this._assertReady();
    if (!this._scene || !this._tile) throw new Error('Load a room photo and tile before rendering.');
    const started = performance.now();
    const groutColor = rgb(settings.groutColor ?? '#d6d0c5');
    const groutMm = finite(settings.groutMm ?? 3, 'Grout width');
    if (groutMm < 0 || groutMm > 50) throw new Error('Grout width must be between 0 and 50 mm.');
    const scale = positive(settings.scale ?? 1, 'Tile scale');
    if (scale < 0.05 || scale > 20) throw new Error('Tile scale must be between 0.05 and 20.');
    const rotation = finite(settings.rotation ?? 0, 'Tile rotation');
    if (rotation % 90 !== 0) throw new Error('Tile rotation must be a multiple of 90 degrees.');
    const layout = settings.layout ?? 'straight';
    if (!['straight', 'offset', 'brick', 'staggered', 'running-bond'].includes(layout)) throw new Error('Choose straight or offset layout.');
    const shadingStrength = finite(settings.shadingStrength ?? 0.65, 'Shading strength');
    if (shadingStrength < 0 || shadingStrength > 1) throw new Error('Shading strength must be between 0 and 1.');
    const gl = this.gl, u = this._uniform, scene = this._scene, tile = this._tile;
    gl.useProgram(this._program);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.DITHER);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
    gl.enableVertexAttribArray(this._position);
    gl.vertexAttribPointer(this._position, 2, gl.FLOAT, false, 0, 0);
    this._textures.forEach((texture, index) => {
      gl.activeTexture(gl.TEXTURE0 + index);
      gl.bindTexture(gl.TEXTURE_2D, texture);
    });
    gl.uniform1i(u.uScene, 0);
    gl.uniform1i(u.uTile, 1);
    gl.uniform1i(u.uMask, 2);
    gl.uniform1i(u.uLight, 3);
    gl.uniform1f(u.uMode, 0);
    gl.uniformMatrix3fv(u.uImageToPlane, false, columnMajor(scene.inverse));
    gl.uniform2f(u.uPlaneMm, scene.widthMm / 1000, scene.depthMm / 1000);
    gl.uniform2f(u.uTileMm, tile.widthMm * scale / 1000, tile.heightMm * scale / 1000);
    gl.uniform3fv(u.uGroutColor, groutColor);
    gl.uniform1f(u.uGroutMm, groutMm / 1000);
    gl.uniform1f(u.uRotation, ((rotation / 90) % 4 + 4) % 4);
    gl.uniform1f(u.uBrick, layout === 'straight' ? 0 : 1);
    gl.uniform1f(u.uShading, shadingStrength);
    gl.uniform1f(u.uReferenceLight, scene.referenceLight);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // Browser command submission alone can appear to take 0 ms. Read an actual
    // framebuffer result to include the wait for drawing to become available.
    gl.readPixels(Math.floor(this.canvas.width / 2), Math.floor(this.canvas.height / 2),
      1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this._readbackPixel);
    const durationMs = performance.now() - started;
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`Tile rendering failed (WebGL error ${error}).`);
    return { durationMs, width: this.canvas.width, height: this.canvas.height,
      method: 'webgl-perspective', timing: 'draw and synchronous 1-pixel readback; excludes display presentation',
      gpuResultReadBack: true,
      antialiasedGrout: this._hasDerivatives };
  }

  destroy() {
    if (this._destroyed) return;
    this.canvas.removeEventListener('webglcontextlost', this._onLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onRestored);
    const gl = this.gl;
    this._textures?.forEach(texture => gl.deleteTexture(texture));
    gl.deleteBuffer(this._buffer);
    gl.deleteProgram(this._program);
    this._scene = null;
    this._tile = null;
    this._destroyed = true;
  }
}

function normaliseSurfaceSettings(settings = {}) {
  const groutColor = rgb(settings.groutColor ?? '#d6d0c5');
  const groutMm = finite(settings.groutMm ?? 3, 'Grout width');
  if (groutMm < 0 || groutMm > 50) throw new Error('Grout width must be between 0 and 50 mm.');
  const scale = positive(settings.scale ?? 1, 'Tile scale');
  if (scale < 0.05 || scale > 20) throw new Error('Tile scale must be between 0.05 and 20.');
  const rotation = finite(settings.rotation ?? 0, 'Tile rotation');
  if (![0, 90].includes(rotation)) throw new Error('Multi-surface rotation must be 0 or 90 degrees.');
  const layout = settings.layout ?? 'straight';
  if (!['straight', 'offset'].includes(layout)) throw new Error('Choose straight or offset layout.');
  return { groutColor, groutMm, scale, rotation: rotation / 90, brick: layout === 'offset' ? 1 : 0 };
}

function boundedPoint(value, name) {
  const result = point(value, name);
  if (result.some(coordinate => coordinate < -2 || coordinate > 3)) throw new Error(`${name} coordinates must be between -2 and 3.`);
  return result;
}

/**
 * Multi-plane adapter sharing one WebGL context and one original scene texture.
 * Draw order follows the surfaces array; a later surface covers earlier surfaces
 * only where its mask is visible. Its exclusion holes reveal the layers below.
 */
export class MultiSurfaceRenderer extends TileRenderer {
  constructor(canvas) { super(canvas); }

  _createResources() {
    super._createResources();
    // This also runs after context recovery, when old GL handles are invalid.
    this._multiScene = null;
    this._surfaces = [];
    this._surfaceResources = new Map();
    this._tileResources = new Map();
    this._sceneVersion = 0;
    this._resourceClock = 0;
  }

  async setScene({ image }) {
    this._assertReady();
    const size = dimensions(image, 'Room photo');
    const ratio = Math.min(1, Math.min(MAX_SCENE_EDGE, this._maxTextureSize) / Math.max(size.width, size.height));
    const width = Math.max(1, Math.round(size.width * ratio)), height = Math.max(1, Math.round(size.height * ratio));
    const sourceKey = image.currentSrc || image.src || '';
    if (this._multiScene?.image === image && this._multiScene.sourceKey === sourceKey && this._multiScene.width === width && this._multiScene.height === height) {
      return { width, height, sourceReused: true };
    }
    const photo = surface(width, height);
    context2d(photo).drawImage(image, 0, 0, width, height);
    const lightRatio = Math.min(1, 256 / Math.max(width, height));
    const lighting = surface(Math.max(1, Math.round(width * lightRatio)), Math.max(1, Math.round(height * lightRatio)));
    const lightContext = context2d(lighting);
    lightContext.filter = 'blur(5px)';
    lightContext.drawImage(photo, 0, 0, lighting.width, lighting.height);
    lightContext.filter = 'none';
    const lightPixels = lightContext.getImageData(0, 0, lighting.width, lighting.height).data;
    this._upload(0, photo);
    this._upload(3, lighting);
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this._multiScene = { image, sourceKey, width, height, lighting, lightPixels, version: ++this._sceneVersion };
    // A new room must explicitly receive its own surfaces before it is rendered.
    this._surfaces = [];
    return { width, height, sourceWidth: size.width, sourceHeight: size.height, sourceReused: false };
  }

  _referenceLight(quad, exclusions) {
    const { lighting, lightPixels } = this._multiScene;
    let total = 0, count = 0;
    for (let y = 0; y < lighting.height; y += 3) for (let x = 0; x < lighting.width; x += 3) {
      const sample = [(x + 0.5) / lighting.width, (y + 0.5) / lighting.height];
      if (!insidePolygon(sample, quad) || exclusions.some(polygon => insidePolygon(sample, polygon))) continue;
      const offset = (y * lighting.width + x) * 4;
      total += (lightPixels[offset] * 0.2126 + lightPixels[offset + 1] * 0.7152 + lightPixels[offset + 2] * 0.0722) / 255;
      count += 1;
    }
    return count ? total / count : 0.5;
  }

  async setSurfaces({ surfaces, tiles }) {
    this._assertReady();
    if (!this._multiScene) throw new Error('Load the room photo before its surfaces.');
    if (!Array.isArray(surfaces) || surfaces.length < 1 || surfaces.length > 4) throw new Error('Choose between one and four surfaces.');
    if (!tiles || (typeof tiles !== 'object' && !(tiles instanceof Map))) throw new Error('Provide a map of loaded tile images.');
    const usedIds = new Set();
    // Validate the complete request before changing visible state or GPU caches.
    const definitions = surfaces.map((item, index) => {
      if (!item || !/^[A-Za-z0-9_-]{1,40}$/.test(item.id ?? '')) throw new Error(`Surface ${index + 1} needs a valid stable ID.`);
      if (usedIds.has(item.id)) throw new Error('Surface IDs must be unique.');
      usedIds.add(item.id);
      if (!['floor', 'wall', 'splashback'].includes(item.kind)) throw new Error(`Surface ${item.id} needs a valid kind.`);
      const quad = validateQuad(item.quad).map((p, i) => boundedPoint(p, `${item.id}.quad[${i}]`));
      const exclusions = item.exclusions ?? [];
      if (!Array.isArray(exclusions) || exclusions.length > 12) throw new Error(`Surface ${item.id} allows up to twelve protected regions.`);
      const polygons = exclusions.map((polygon, p) => {
        if (!Array.isArray(polygon) || polygon.length < 3 || polygon.length > 32) throw new Error(`Protected region ${p + 1} needs 3–32 points.`);
        return polygon.map((value, i) => boundedPoint(value, `${item.id}.exclusions[${p}][${i}]`));
      });
      const entry = tiles instanceof Map ? tiles.get(item.tileId) : (Object.hasOwn(tiles, item.tileId) ? tiles[item.tileId] : null);
      if (!entry?.image) throw new Error(`The tile image for ${item.tileId} has not been loaded.`);
      const imageSize = dimensions(entry.image, `Tile ${item.tileId}`);
      return { id: item.id, tileId: item.tileId, quad, exclusions: polygons,
        inverse: columnMajor(invertHomography(homographyForQuad(quad))), settings: normaliseSurfaceSettings(item.settings),
        planeWidthMm: positive(item.planeWidthMm ?? (item.kind === 'floor' ? 4200 : 3600), 'Surface width'),
        planeDepthMm: positive(item.planeDepthMm ?? (item.kind === 'floor' ? 4000 : 2600), 'Surface depth'),
        image: entry.image, imageSize, tileWidthMm: positive(entry.widthMm ?? 600, 'Tile width'), tileHeightMm: positive(entry.heightMm ?? 600, 'Tile height') };
    });
    const scene = this._multiScene, gl = this.gl;
    const stagedTiles = new Map(), stagedMasks = new Map(), createdTextures = new Set();
    let tileUploads = 0, maskUploads = 0;
    try {
      for (const definition of definitions) {
        const image = definition.image, sourceKey = image.currentSrc || image.src || '';
        const existingTile = stagedTiles.get(definition.tileId) || this._tileResources.get(definition.tileId);
        let tileResource = existingTile;
        if (!existingTile || existingTile.image !== image || existingTile.sourceKey !== sourceKey || existingTile.sourceWidth !== definition.imageSize.width || existingTile.sourceHeight !== definition.imageSize.height) {
          const limit = Math.min(MAX_TILE_EDGE, this._maxTextureSize);
          const pot = value => Math.min(limit, 2 ** Math.ceil(Math.log2(Math.max(1, value))));
          const prepared = surface(pot(definition.imageSize.width), pot(definition.imageSize.height));
          context2d(prepared).drawImage(image, 0, 0, prepared.width, prepared.height);
          const texture = gl.createTexture(); createdTextures.add(texture);
          this._uploadTexture(texture, 1, prepared, true);
          tileResource = { texture, image, sourceKey, sourceWidth: definition.imageSize.width, sourceHeight: definition.imageSize.height };
          tileUploads += 1;
        }
        stagedTiles.set(definition.tileId, tileResource);
        const maskKey = JSON.stringify([scene.width, scene.height, definition.quad, definition.exclusions]);
        const previousMask = this._surfaceResources.get(definition.id);
        let maskResource;
        if (previousMask?.key === maskKey) {
          maskResource = previousMask.sceneVersion === scene.version ? previousMask : {
            ...previousMask, referenceLight: this._referenceLight(definition.quad, definition.exclusions), sceneVersion: scene.version,
          };
        } else {
          const mask = surface(scene.width, scene.height), maskContext = context2d(mask);
          maskContext.fillStyle = '#000'; maskContext.fillRect(0, 0, scene.width, scene.height);
          maskContext.fillStyle = '#fff'; polygonPath(maskContext, definition.quad, scene.width, scene.height); maskContext.fill();
          maskContext.fillStyle = '#000';
          definition.exclusions.forEach(polygon => { polygonPath(maskContext, polygon, scene.width, scene.height); maskContext.fill(); });
          const texture = gl.createTexture(); createdTextures.add(texture);
          this._uploadTexture(texture, 2, mask);
          maskResource = { key: maskKey, texture, sceneVersion: scene.version, referenceLight: this._referenceLight(definition.quad, definition.exclusions) };
          maskUploads += 1;
        }
        stagedMasks.set(definition.id, maskResource);
        definition.tileResource = tileResource;
        definition.maskResource = maskResource;
      }
      const error = gl.getError();
      if (error !== gl.NO_ERROR) throw new Error(`Surface preparation failed (WebGL error ${error}).`);
    } catch (error) {
      createdTextures.forEach(texture => gl.deleteTexture(texture));
      throw error;
    }
    // Commit after successful preparation. Removed/replaced masks are released.
    this._surfaceResources.forEach((resource, id) => {
      if (stagedMasks.get(id)?.texture !== resource.texture) gl.deleteTexture(resource.texture);
    });
    for (const [id, resource] of stagedTiles) {
      const previous = this._tileResources.get(id);
      if (previous && previous.texture !== resource.texture) gl.deleteTexture(previous.texture);
      resource.lastUsed = ++this._resourceClock;
      this._tileResources.set(id, resource);
    }
    // Keep a small recent cache for switching materials, with a fixed memory cap.
    if (this._tileResources.size > 8) {
      const inactive = [...this._tileResources.entries()].filter(([id]) => !stagedTiles.has(id)).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      for (const [id, resource] of inactive) {
        if (this._tileResources.size <= 8) break;
        gl.deleteTexture(resource.texture); this._tileResources.delete(id);
      }
    }
    this._surfaceResources = stagedMasks;
    this._surfaces = definitions;
    return { surfaceCount: definitions.length, tileUploads, maskUploads };
  }

  render() {
    this._assertReady();
    if (!this._multiScene || !this._surfaces.length) throw new Error('Load the room and configure its surfaces before rendering.');
    const started = performance.now(), gl = this.gl, u = this._uniform, scene = this._multiScene;
    gl.useProgram(this._program); gl.viewport(0, 0, scene.width, scene.height);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.DITHER);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer); gl.enableVertexAttribArray(this._position);
    gl.vertexAttribPointer(this._position, 2, gl.FLOAT, false, 0, 0);
    const bind = (slot, texture) => { gl.activeTexture(gl.TEXTURE0 + slot); gl.bindTexture(gl.TEXTURE_2D, texture); };
    bind(0, this._textures[0]); bind(3, this._textures[3]);
    bind(1, this._surfaces[0].tileResource.texture); bind(2, this._surfaces[0].maskResource.texture);
    gl.uniform1i(u.uScene, 0); gl.uniform1i(u.uTile, 1); gl.uniform1i(u.uMask, 2); gl.uniform1i(u.uLight, 3);
    // The original photo is written once. Later passes only write their masks.
    gl.uniform1f(u.uMode, 1); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.uniform1f(u.uMode, 2); gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    for (const item of this._surfaces) {
      const settings = item.settings;
      bind(1, item.tileResource.texture); bind(2, item.maskResource.texture);
      gl.uniformMatrix3fv(u.uImageToPlane, false, item.inverse);
      gl.uniform2f(u.uPlaneMm, item.planeWidthMm / 1000, item.planeDepthMm / 1000);
      gl.uniform2f(u.uTileMm, item.tileWidthMm * settings.scale / 1000, item.tileHeightMm * settings.scale / 1000);
      gl.uniform3fv(u.uGroutColor, settings.groutColor); gl.uniform1f(u.uGroutMm, settings.groutMm / 1000);
      gl.uniform1f(u.uRotation, settings.rotation); gl.uniform1f(u.uBrick, settings.brick);
      gl.uniform1f(u.uShading, 0.65); gl.uniform1f(u.uReferenceLight, item.maskResource.referenceLight);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.disable(gl.BLEND);
    gl.readPixels(Math.floor(scene.width / 2), Math.floor(scene.height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this._readbackPixel);
    const durationMs = performance.now() - started;
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`Multi-surface rendering failed (WebGL error ${error}).`);
    return { durationMs, width: scene.width, height: scene.height, method: 'webgl-multisurface', surfaceCount: this._surfaces.length,
      timing: 'background plus ordered surface draws and synchronous 1-pixel readback; excludes display presentation', gpuResultReadBack: true };
  }

  destroy() {
    if (this._destroyed) return;
    this._surfaceResources.forEach(resource => this.gl.deleteTexture(resource.texture));
    this._tileResources.forEach(resource => this.gl.deleteTexture(resource.texture));
    this._surfaceResources.clear(); this._tileResources.clear(); this._surfaces = []; this._multiScene = null;
    super.destroy();
  }
}
