import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateImage, readConfiguration } from '../provider-client.mjs';

const key = 'test-secret-DO-NOT-EXPOSE';
async function mock(t, handler) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return readConfiguration({ TILE_API_KEY: key, TILE_API_MODEL: 'mock-model', TILE_API_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` });
}
test('configuration rejects insecure nonlocal/credential/query endpoints and has no model default', () => {
  for (const base of ['http://example.com/v1','https://user:pass@example.com/v1','https://example.com/v1?key=secret','ftp://localhost/v1']) assert.equal(readConfiguration({ TILE_API_KEY:key,TILE_API_MODEL:'mock',TILE_API_BASE_URL:base }).configured,false);
  assert.equal(readConfiguration({ TILE_API_KEY:key }).configured,false);
});
test('Responses request carries auth only in header; identity remains unknown when omitted', async t => {
  const configuration = await mock(t, async (req,res) => {
    assert.equal(req.headers.authorization,`Bearer ${key}`);assert.equal(req.url,'/v1/responses');
    let body='';for await (const chunk of req) body+=chunk;
    assert.ok(!body.includes(key));const parsed=JSON.parse(body);assert.equal(parsed.store,false);assert.equal(parsed.stream,false);assert.equal(parsed.tools[0].type,'image_generation');
    res.end(JSON.stringify({status:'completed',output:[{type:'image_generation_call',result:Buffer.from('test-bytes').toString('base64')}]}));
  });
  const result=await generateImage({configuration,content:[{type:'input_text',text:'test'}]});
  assert.equal(result.bytes.toString(),'test-bytes');assert.equal(result.responseModel,null);assert.equal(result.responseImageModel,null);
});
test('errors never expose provider text; redirects are not followed', async t => {
  let calls=0;const configuration=await mock(t,(req,res)=>{calls++;res.writeHead(302,{Location:'/steal'});res.end(key);});
  await assert.rejects(generateImage({configuration,content:[]}),e=>!JSON.stringify(e).includes(key)&&e.errorCode==='provider_error');assert.equal(calls,1);
});
test('HTTP errors are allowlisted and rate delay retained without a retry', async t=>{
  let calls=0;const configuration=await mock(t,(req,res)=>{calls++;res.writeHead(429,{'Retry-After':'60'});res.end(key);});
  await assert.rejects(generateImage({configuration,content:[]}),e=>e.errorCode==='rate_limit'&&e.recovery.retryAfterMs===60000&&!e.message.includes(key));assert.equal(calls,1);
});
test('timeout and cancellation retain uncertain execution state',async t=>{
  const configuration=await mock(t,()=>{});
  await assert.rejects(generateImage({configuration,content:[],timeoutMs:30}),e=>e.errorCode==='timeout'&&e.recovery.executionState==='uncertain');
  const controller=new AbortController();setTimeout(()=>controller.abort(),30);
  await assert.rejects(generateImage({configuration,content:[],signal:controller.signal}),e=>e.errorCode==='cancelled'&&e.recovery.executionState==='uncertain');
});
