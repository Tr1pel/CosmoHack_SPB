import {readdir,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
for(const dir of ['dist','pipeline','scripts','tests'])for(const name of await readdir(dir))if(/\.(mjs|js)$/.test(name)){
  const result=spawnSync(process.execPath,['--check',`${dir}/${name}`],{encoding:'utf8'});
  if(result.status!==0){console.error(result.stderr||result.error);process.exit(1);}
}
for(const name of await readdir('dist'))if(/\.(js|css|html)$/.test(name)){
  if((await readFile(`dist/${name}`,'utf8'))!==(await readFile(`docs/${name}`,'utf8')))throw new Error(`Static mirror drift: ${name}`);
}
console.log('Syntax and dist/docs mirror OK');
