// Deterministic technical fixtures drawn from geometric primitives. No source photos.
import { mkdir, writeFile } from 'node:fs/promises';
const root=new URL('../',import.meta.url);
await mkdir(new URL('public/assets/',root),{recursive:true});
const room=`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
<rect width="1200" height="800" fill="#ebe7df"/><path d="M0 0H1200V800L960 440H240L0 800Z" fill="#e0ded6"/>
<path d="M240 80H960V440H240Z" fill="#f4f0e8" stroke="#b3ada2" stroke-width="3"/>
<path d="M0 800L240 440H960L1200 800Z" fill="#cbc3b5" stroke="#b3ada2" stroke-width="3"/>
<path d="M0 0L240 80V440L0 800M1200 0L960 80" fill="none" stroke="#b3ada2" stroke-width="3"/>
<rect x="390" y="150" width="180" height="180" fill="#b9d0d3" stroke="#736f66" stroke-width="12"/>
<path d="M480 150V330M390 240H570" stroke="#f7f4ed" stroke-width="6"/>
<rect x="720" y="485" width="140" height="140" fill="#766857"/><path d="M720 485L760 452H900L860 485Z" fill="#a08e78"/><path d="M860 485L900 452V592L860 625Z" fill="#63584b"/>
</svg>`;
await writeFile(new URL('public/assets/demo-room.svg',root),room);
const palettes=[['sand','Sand demo','#d7c9b5','#cabba6'],['chalk','Chalk demo','#e9e6df','#d9d5cd'],['slate','Slate demo','#667078','#576169']];
for(const [id,,base,accent] of palettes){
  const marks=Array.from({length:24},(_,i)=>`<path d="M${(i*47)%300} ${(i*71)%300}l${20+i%9} ${3+i%5}" stroke="${accent}" stroke-width="2" opacity=".5"/>`).join('');
  await writeFile(new URL(`public/assets/demo-${id}.svg`,root),`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="${base}"/>${marks}</svg>`);
}
const settings={groutColor:'#d6d0c5',groutMm:3,rotation:0,layout:'straight',scale:1};
const surfaces=[
 {id:'floor-1',label:'Floor',kind:'floor',tileId:'sand',quad:[[.2,.55],[.8,.55],[1,1],[0,1]],exclusions:[[[.6,.60625],[.63333,.565],[.75,.565],[.75,.74],[.71667,.78125],[.6,.78125]]],settings,planeWidthMm:4200,planeDepthMm:4000},
 {id:'wall-1',label:'Back wall',kind:'wall',tileId:'chalk',quad:[[.2,.1],[.8,.1],[.8,.55],[.2,.55]],exclusions:[[[.32,.18],[.48,.18],[.48,.42],[.32,.42]]],settings,planeWidthMm:4200,planeDepthMm:2400}
];
const catalog={rooms:[{id:'demo-room',name:'Schematic room',src:'/assets/demo-room.svg',width:1200,height:800,synthetic:true,sourceNote:'Original geometric demo drawing. Not a real room or AI-generated photograph.',surfaces}],tiles:palettes.map(([id,name])=>({id,name,src:`/assets/demo-${id}.svg`,widthMm:600,heightMm:600})),testCases:[],examples:[]};
await writeFile(new URL('catalog.json',root),JSON.stringify(catalog,null,2)+'\n');
console.log('Created one schematic and three synthetic tile textures.');
