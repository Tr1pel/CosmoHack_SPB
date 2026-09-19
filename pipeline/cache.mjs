import {mkdir,readFile,writeFile,readdir,rename} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {validateRecord} from './quality.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
export class Cache {
  constructor(root='local/pipeline',fetcher=fetch){this.root=resolve(root);this.fetcher=fetcher;this.pending=new Map();}
  async read(path,fallback){try{return JSON.parse(await readFile(join(this.root,path),'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
  async write(path,value){const file=join(this.root,path);await mkdir(resolve(file,'..'),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(value));await rename(temp,file);}
  async fetch(sourceId,url,ttlMinutes){
    const key=hash(url);
    if(this.pending.has(key))return this.pending.get(key);
    const job=this.fetchOnce(sourceId,url,ttlMinutes,key).finally(()=>this.pending.delete(key));this.pending.set(key,job);return job;
  }
  async fetchOnce(sourceId,url,ttlMinutes,key){
    const old=await this.read(`requests/${key}.json`,null),now=Date.now();
    if(old&&now-Date.parse(old.attemptedAt)<ttlMinutes*60000){if(old.error)throw new Error(old.error);return this.read(`raw/${old.hash}.json`,null);}
    const attemptedAt=new Date(now).toISOString();
    try {
      const response=await this.fetcher(url,{signal:AbortSignal.timeout(12000),headers:{'User-Agent':'CosmoHack-research/2.0'}});
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const raw=await response.text();if(raw.length>20_000_000)throw new Error('Source response exceeds 20 MB');
      const snapshot={sourceId,url,fetchedAt:new Date().toISOString(),publishedAt:null,sourceVersion:hash(raw),raw};
      const digest=hash(JSON.stringify(snapshot));
      await this.write(`raw/${digest}.json`,snapshot);await this.write(`requests/${key}.json`,{attemptedAt,hash:digest});return snapshot;
    } catch(e){await this.write(`requests/${key}.json`,{attemptedAt,error:e.message});throw e;}
  }
  async append(records){for(const r of records)validateRecord(r);if(records.length)await this.write(`records/${hash(JSON.stringify(records))}.json`,records);}
  async records(){const folder=join(this.root,'records');let names;try{names=await readdir(folder);}catch(e){if(e.code==='ENOENT')return [];throw e;}return (await Promise.all(names.filter(x=>x.endsWith('.json')).map(n=>this.read(`records/${n}`,[])))).flat();}
}
