import https from 'node:https';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';

try {
  const dotenv=await readFile('.env','utf8');
  for(const line of dotenv.split(/\r?\n/)){const match=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);if(match&&!process.env[match[1]])process.env[match[1]]=match[2].replace(/^['"]|['"]$/g,'');}
} catch(error) { if(error.code!=='ENOENT')throw error; }
const identity=process.env.SPACE_TRACK_IDENTITY,password=process.env.SPACE_TRACK_PASSWORD;
const output=resolve(process.argv[2]||'local/space-track/gp_history-25544.json');
if(!identity||!password||identity==='you@example.com'||password==='replace-with-your-password')throw new Error('Set SPACE_TRACK_IDENTITY and SPACE_TRACK_PASSWORD in .env before requesting Space-Track.');
const request=(url,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{
  const req=https.request(url,{method,headers:{'User-Agent':'CosmoHack-research/2.0',...headers}},res=>{
    let data='';res.setEncoding('utf8');res.on('data',chunk=>data+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:data}));
  });req.on('error',reject);if(body)req.write(body);req.end();
});
const loginBody=new URLSearchParams({identity,password}).toString();
const login=await request('https://www.space-track.org/ajaxauth/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(loginBody)},body:loginBody});
const cookies=(login.headers['set-cookie']??[]).map(value=>value.split(';',1)[0]).join('; ');
if(login.status!==200||!cookies)throw new Error(`Space-Track login failed (HTTP ${login.status}). Check the account, password and accepted terms.`);
// gp_history is deliberately explicit and separate from normal collection: its access may be
// limited by Space-Track policy, so this command is never run implicitly by the API.
const data=await request('https://www.space-track.org/basicspacedata/query/class/gp_history/NORAD_CAT_ID/25544/orderby/EPOCH%20asc/format/json',{headers:{Cookie:cookies}});
if(data.status!==200)throw new Error(`Space-Track gp_history request failed (HTTP ${data.status}).`);
let records;try{records=JSON.parse(data.body);}catch{throw new Error('Space-Track returned a non-JSON gp_history response.');}
if(!Array.isArray(records)||!records.length)throw new Error('Space-Track returned no OMM records for NORAD 25544.');
await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(records,null,2));
console.log(JSON.stringify({output,records:records.length,objectId:25544}));
