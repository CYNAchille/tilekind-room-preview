import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root=new URL('../',import.meta.url),files=[];
async function walk(prefix='') {
  for(const entry of await readdir(new URL(prefix,root),{withFileTypes:true})){
    const name=prefix+entry.name;
    if(name==='RELEASE-MANIFEST.json')continue;
    if(entry.isDirectory())await walk(name+'/');
    else if(entry.isFile()){
      const data=await readFile(new URL(name,root));
      files.push({path:name,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
    } else throw new Error(`Unsupported release entry: ${name}`);
  }
}
await walk();files.sort((a,b)=>a.path.localeCompare(b.path));
await writeFile(new URL('RELEASE-MANIFEST.json',root),JSON.stringify({formatVersion:1,status:'local-candidate-license-pending',files},null,2)+'\n');
console.log(`Manifest: ${files.length} files`);
