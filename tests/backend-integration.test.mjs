import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, readFile, rm, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
const root=fileURLToPath(new URL('../',import.meta.url));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
test('server supports SVG fixtures, one durable request, restart recovery and private path/origin boundaries',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'tilekind-backend-test-'));let child;let calls=0;
 const png=await sharp({create:{width:32,height:32,channels:3,background:'#ddd'}}).png().toBuffer();
 const provider=createServer(async(req,res)=>{calls++;let data='';for await(const chunk of req)data+=chunk;const body=JSON.parse(data);assert.ok(body.input[0].content.filter(x=>x.type==='input_image').every(x=>x.image_url.startsWith('data:image/png;base64,')));res.end(JSON.stringify({status:'completed',model:'mock-model',output:[{type:'image_generation_call',result:png.toString('base64')}]}));});
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 t.after(async()=>{if(child&&child.exitCode===null){child.kill();await once(child,'exit');}provider.closeAllConnections();provider.close();await rm(dir,{recursive:true,force:true});});
 for(const name of ['server.mjs','provider-client.mjs','recovery-errors.mjs','job-store.mjs','image-output.mjs','guide-image.mjs','build-prompt.mjs','catalog.json','public'])await cp(join(root,name),join(dir,name),{recursive:true});
 await symlink(join(root,'node_modules'),join(dir,'node_modules'),process.platform==='win32'?'junction':'dir');
 const localPort=await port();const base=`http://127.0.0.1:${localPort}`;const key='integration-secret-do-not-save';
 const start=async(configured=true)=>{child=spawn(process.execPath,['server.mjs'],{cwd:dir,env:{...process.env,TILE_EDITOR_PORT:String(localPort),TILE_API_KEY:configured?key:'',TILE_API_MODEL:'mock-model',TILE_API_BASE_URL:`http://127.0.0.1:${provider.address().port}/v1`},stdio:'pipe',windowsHide:true});let output='';child.stderr.on('data',b=>output+=b);for(let i=0;i<100;i++){try{const response=await fetch(base+'/api/health');if(response.ok)return await response.json();}catch{}await pause(30);}throw Error('Server did not start: '+output);};
 const health=await start();assert.equal(health.configured,true);assert.ok(!JSON.stringify(health).includes(key));assert.equal(calls,0);
 const post=(path,body,origin=base)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)});
 const catalog=await(await fetch(base+'/api/catalog')).json();const request={roomId:catalog.rooms[0].id,surfaces:catalog.rooms[0].surfaces,clientRequestId:crypto.randomUUID()};
 assert.equal((await post('/api/generate',request,'https://evil.example')).status,403);
 assert.equal((await post('/api/generate',{...request,apiKey:'unexpected'})).status,400);
 for(const path of ['/server.mjs','/.env','/package.json','/evidence/jobs/runtime.lock','/private-tmp/test'])assert.equal((await fetch(base+path)).status,404,path);
 assert.equal((await fetch(base+'/%2e%2e%2fserver.mjs')).status,400);
 const accepted=await(await post('/api/generate',request)).json();assert.ok(accepted.jobId);
 const duplicate=await(await post('/api/generate',request)).json();assert.equal(duplicate.jobId,accepted.jobId);assert.equal(duplicate.duplicate,true);
 let job;for(let i=0;i<150;i++){job=await(await fetch(base+'/api/jobs/'+accepted.jobId)).json();if(['done','failed'].includes(job.status))break;await pause(40);}
 assert.equal(job.status,'done',JSON.stringify(job));assert.equal(calls,1);assert.equal((await fetch(base+job.resultUrl)).status,200);
 const evidence=await readFile(join(dir,'evidence/jobs',accepted.jobId+'.json'),'utf8');assert.ok(!evidence.includes(key));assert.ok(!evidence.includes('data:image'));
 child.kill();await once(child,'exit');await start();const restored=await(await post('/api/generate',request)).json();assert.equal(restored.jobId,accepted.jobId);assert.equal(restored.status,'done');assert.equal(calls,1);
 child.kill();await once(child,'exit');const disabled=await start(false);assert.equal(disabled.configured,false);assert.equal((await post('/api/generate',{...request,clientRequestId:crypto.randomUUID()})).status,503);assert.equal(calls,1);
});
