import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const freePort=()=>new Promise(resolve=>{const s=createServer().listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(()=>resolve(port));});});
// The real entry point of `npm run dev` and of the Docker image, started as a process.
test('server starts, serves the app and answers the v2 dataset API offline',async()=>{
 const cache=await mkdtemp(join(tmpdir(),'eva-serve-')),port=await freePort();
 const child=spawn(process.execPath,['scripts/serve.mjs'],{cwd:root,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',PIPELINE_OFFLINE:'1',PIPELINE_CACHE:cache,PIPELINE_PYTHON:''},stdio:['ignore','pipe','pipe']});
 try{
  let log='';child.stderr.on('data',b=>log+=b);
  await new Promise((resolve,reject)=>{child.stdout.on('data',b=>{if(String(b).includes('Local:'))resolve();});child.on('exit',code=>reject(new Error(`server exited with ${code}: ${log}`)));});
  const base=`http://127.0.0.1:${port}`;
  const page=await fetch(base+'/');assert.equal(page.status,200);assert.match(await page.text(),/<div id="app">/);
  assert.match(await (await fetch(base+'/config.js')).text(),/apiBaseUrl:'\/'/);
  const request=JSON.parse(await readFile(join(root,'data/request.example.json'),'utf8'));
  const post=(headers={})=>fetch(base+'/v2/eva/dataset',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({request,disabledSources:[]})});
  const response=await post();assert.equal(response.status,200);
  const dataset=await response.json();assert.equal(dataset.schemaVersion,2);assert.equal(dataset.demo,false);
  // Behind nginx the Host header must reach the app: a foreign Origin is refused.
  assert.equal((await post({Origin:'http://example.com'})).status,403);
 }finally{
  if(child.exitCode===null){child.kill();await once(child,'exit');}
  await rm(cache,{recursive:true,force:true});
 }
});
