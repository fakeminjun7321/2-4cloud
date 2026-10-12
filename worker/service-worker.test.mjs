import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../public/sw.js',import.meta.url),'utf8');
function setup({hit,put=async()=>{},keys=[]}={}) {
 const handlers={}; const network=[]; const deleted=[]; const pending=[];
 const caches={match:async()=>hit,open:async()=>({put}),keys:async()=>keys,delete:async(key)=>deleted.push(key)};
 const self={location:{origin:'https://example.test'},addEventListener:(name,fn)=>{handlers[name]=fn;},clients:{claim:async()=>{}}};
 vm.runInNewContext(source,{self,caches,URL,fetch:async(r)=>{network.push(r.url);return new Response('network bytes');}});
 return {handlers,network,deleted,pending,read(path){let response;handlers.fetch({request:new Request(`https://example.test${path}`),respondWith:p=>{response=p;},waitUntil:p=>pending.push(p)});return response;}};
}

test('fingerprinted assets reuse cache without another network request',async()=>{
 const env=setup({hit:new Response('cached bundle')});
 assert.equal(await (await env.read('/assets/index-abcdefgh.js')).text(),'cached bundle');
 assert.equal(env.network.length,0);
});

test('successful network responses are not delayed or failed by cache storage',async()=>{
 let finish;const write=new Promise(resolve=>{finish=resolve;});
 const env=setup({put:()=>write});
 const response=await env.read('/index.html');
 assert.equal(await response.text(),'network bytes');
 assert.equal(env.pending.length,1);finish();await Promise.all(env.pending);
 const broken=setup({put:async()=>{throw new Error('QuotaExceededError');}});
 assert.equal(await(await broken.read('/index.html')).text(),'network bytes');await Promise.all(broken.pending);
});

test('API downloads bypass the service worker and activation only removes owned caches',async()=>{
 const env=setup({keys:['2-4-cloud-shell-v1','2-4-cloud-shell-v2','other-cache']});
 assert.equal(env.read('/api/files/1'),undefined);
 env.handlers.activate({waitUntil:p=>env.pending.push(p)});await Promise.all(env.pending);
 assert.deepEqual(env.deleted,['2-4-cloud-shell-v1']);
});
