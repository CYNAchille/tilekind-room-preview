import test from 'node:test';
import assert from 'node:assert/strict';
import { homographyForQuad, invertHomography, projectPoint, validateQuad } from '../public/renderer.js';
import { normalizeQuadWinding } from '../public/quad-geometry.js';

test('perspective maps all four corners and round-trips interior points',()=>{
  const quad=[[.2,.5],[.8,.5],[1,1],[0,1]], square=[[0,0],[1,0],[1,1],[0,1]];
  const matrix=homographyForQuad(quad),inverse=invertHomography(matrix);
  const close=(a,b)=>a.forEach((value,i)=>assert.ok(Math.abs(value-b[i])<1e-8));
  square.forEach((point,i)=>close(projectPoint(matrix,point),quad[i]));
  for(const point of [[.1,.7],[.5,.5],[.9,.1]])close(projectPoint(inverse,projectPoint(matrix,point)),point);
});
test('crossing, concave, duplicate and degenerate corners are rejected',()=>{
  for(const quad of [[[0,0],[1,1],[1,0],[0,1]],[[0,0],[1,0],[.2,.2],[0,1]],[[0,0],[0,0],[1,1],[0,1]],[[0,0],[1,0],[2,0],[3,0]]]){
    assert.equal(normalizeQuadWinding(quad),null); assert.throws(()=>validateQuad(quad));
  }
});
test('reverse drawing preserves anchor and corrects winding without mutating points',()=>{
  const quad=[[0,0],[0,1],[1,1],[1,0]],copy=structuredClone(quad);
  assert.deepEqual(normalizeQuadWinding(quad),[[0,0],[1,0],[1,1],[0,1]]);
  assert.deepEqual(quad,copy);
});
