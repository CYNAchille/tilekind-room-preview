import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { homographyForQuad, invertHomography, projectPoint, validateQuad } from '../public/renderer.js';
import { normalizeQuadWinding } from '../public/quad-geometry.js';
import { createPreviewServer } from '../server.mjs';

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
test('HTTP demo serves complete catalog and assets; mutation and private files are inaccessible',async t=>{
  const server=createPreviewServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const index=await fetch(base);assert.equal(index.status,200);
  assert.match(await index.text(),/Tile preview · non-AI/);
  const catalog=await (await fetch(base+'/api/catalog')).json();
  assert.equal(catalog.rooms.length,1);assert.equal(catalog.tiles.length,3);
  for(const path of ['/app.js','/renderer.js','/quad-geometry.js','/request-recovery.js','/waiting-motion.js','/ui-copy-en.js','/styles.css','/editor.css',...catalog.rooms.map(r=>r.src),...catalog.tiles.map(r=>r.src)]){
    const response=await fetch(base+path);assert.equal(response.status,200,path);assert.ok((await response.arrayBuffer()).byteLength>0,path);
  }
  assert.equal((await fetch(base+'/api/generate',{method:'POST',body:'{}'})).status,405);
  for(const path of ['/server.mjs','/.env','/package.json','/api/health','/api/jobs/123'])assert.equal((await fetch(base+path)).status,404,path);
  assert.equal((await fetch(base+'/%2e%2e%2fserver.mjs')).status,400);
});
