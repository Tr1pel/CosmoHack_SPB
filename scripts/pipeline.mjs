import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Cache} from '../pipeline/cache.mjs';
import {collect,buildDataset} from '../pipeline/build.mjs';
import * as adapters from '../pipeline/adapters.mjs';
import {validateRequest,computePlan} from '../dist/domain.js';
import {validateV2} from '../dist/pipeline.js';
const [command,...args]=process.argv.slice(2),cache=new Cache(process.env.PIPELINE_CACHE||'local/pipeline');
if(command==='import'){
  const [kind,path]=args,parsers={goes:adapters.goes,hp30:adapters.hp30,omm:adapters.omm,nmdb:adapters.nmdb,socrates:adapters.socrates,donki:adapters.donki,geoalert:adapters.geoalert};
  if(!path||(!parsers[kind]&&kind!=='records'))throw new Error('Usage: pipeline import goes|hp30|omm|nmdb|socrates|donki|geoalert|records FILE');
  const raw=await readFile(path,'utf8'),sourceVersion=createHash('sha256').update(raw).digest('hex');
  const snapshot={sourceId:{goes:'noaa.swpc',hp30:'gfz.hp30',omm:'spacetrack.history',nmdb:'nmdb',socrates:'celestrak.socrates',donki:'nasa.donki',geoalert:'noaa.ncei'}[kind]??'import',raw,sourceVersion,fetchedAt:new Date().toISOString(),publishedAt:null};
  await cache.write(`raw/import-${sourceVersion}.json`,snapshot);
  const records=kind==='records'?JSON.parse(raw):parsers[kind](snapshot);
  await cache.append(records);console.log(JSON.stringify({imported:records.length,version:sourceVersion}));
}else if(command==='fetch'||command==='build'){
  const request=JSON.parse(await readFile(args[0]||'data/request.example.json','utf8'));validateRequest(request);
  const outcomes=command==='fetch'?await collect(cache,request):[];
  if(command==='fetch')console.log(JSON.stringify(outcomes,null,2));
  const dataset=validateV2(await buildDataset(request,await cache.records(),{outcomes}));
  const plan=computePlan(request,dataset),output=args[1]||'local/pipeline-result.json';
  await writeFile(output,JSON.stringify({dataset,plan},null,2));
  console.log(JSON.stringify({output,status:plan.recommended.status,samples:dataset.profile.samples.length,series:dataset.series.length}));
}else throw new Error('Usage: node scripts/pipeline.mjs fetch|build REQUEST.json [OUTPUT.json] | import KIND FILE');
