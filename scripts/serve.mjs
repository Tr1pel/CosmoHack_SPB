import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { Cache } from '../pipeline/cache.mjs';
import { collect, buildDataset } from '../pipeline/build.mjs';
import { validateRequest } from '../dist/domain.js';
const cache=new Cache(process.env.PIPELINE_CACHE||'local/pipeline');
const root = resolve('dist');
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.json':'application/json' };
http.createServer(async(req,res) => {
  try {
    if(req.method==='POST'&&['/v1/eva/dataset','/v2/eva/dataset'].includes(new URL(req.url,'http://localhost').pathname)){
      if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`){res.writeHead(403);return res.end('Origin forbidden');}
      let body='';for await(const chunk of req){body+=chunk;if(body.length>16384){res.writeHead(413);return res.end('Request too large');}}
      let input;try{input=JSON.parse(body);validateRequest(input.request);if(!Array.isArray(input.disabledSources??[]))throw new Error('disabledSources must be an array');}catch(e){res.writeHead(400,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:e.message}));}
      const disabled=input.disabledSources??[];
      const outcomes=process.env.PIPELINE_OFFLINE==='1'?[]:await collect(cache,input.request,disabled);
      const dataset=await buildDataset(input.request,await cache.records(),{disabled,outcomes});
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify(dataset));
    }
    if(req.url==='/config.js'){
      res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'});
      return res.end("export const config={apiBaseUrl:'/'};");
    }
    const path = resolve(root, '.' + decodeURIComponent(new URL(req.url,'http://localhost').pathname === '/' ? '/index.html' : new URL(req.url,'http://localhost').pathname));
    if (!path.startsWith(root + sep)) { res.writeHead(403); return res.end(); }
    const body = await readFile(path);
    res.writeHead(200,{'Content-Type':types[extname(path)] || 'application/octet-stream','Cache-Control':'no-cache'}); res.end(body);
  } catch(e) { res.writeHead(req.method==='POST'?500:404,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:req.method==='POST'?e.message:'Not found'})); }
const port=Number(process.env.PORT||5173),host=process.env.HOST||'127.0.0.1';
}).listen(port, host, () => console.log(`Local: http://${host}:${port}`));
