import {uiSurfaceLabel,uiTileName} from './ui-copy-en.js';

const SVG_NS='http://www.w3.org/2000/svg';
function node(name,attributes={}){const item=document.createElementNS(SVG_NS,name);for(const[key,value]of Object.entries(attributes))item.setAttribute(key,String(value));return item;}
function pathFor(points,scale=1){return points?.length?`M${points.map(([x,y])=>`${x*scale},${y*scale}`).join('L')}Z`:'';}
function visibleBounds(points){
  const xs=points.map(point=>point[0]),ys=points.map(point=>point[1]);
  const left=Math.max(0,Math.min(...xs)),top=Math.max(0,Math.min(...ys));
  return{left,top,width:Math.max(.001,Math.min(1,Math.max(...xs))-left),height:Math.max(.001,Math.min(1,Math.max(...ys))-top)};
}

export class WaitingMotion {
  constructor(root){
    this.root=root;this.room=root.querySelector('.generation-room');this.surfaces=root.querySelector('.generation-surfaces');this.materials=root.querySelector('.generation-materials');this.title=root.querySelector('.generation-title');this.detail=root.querySelector('.generation-detail');this.elapsed=root.querySelector('.generation-elapsed');this.label=root.querySelector('.generation-label');
    this.token=null;this.visible=false;this.hideTimer=null;this.instance=`waiting-${Math.random().toString(36).slice(2,10)}`;
  }
  buildSurfaces(surfaces,tiles){
    const definitions=node('svg',{width:0,height:0,'aria-hidden':'true'});definitions.classList.add('generation-mask-defs');const defs=node('defs');definitions.append(defs);
    const boundaries=node('svg',{viewBox:'0 0 1000 1000',preserveAspectRatio:'none','aria-hidden':'true'});boundaries.classList.add('generation-boundaries');
    const layers=[],assignments=[];
    surfaces.forEach((surface,index)=>{
      const id=`${this.instance}-${index}`,delay=`${-1.05-index*.65}s`;
      const clip=node('clipPath',{id,clipPathUnits:'objectBoundingBox'});clip.append(node('path',{d:pathFor(surface.quad)+(surface.exclusions||[]).map(points=>pathFor(points)).join(''),'clip-rule':'evenodd','fill-rule':'evenodd'}));defs.append(clip);
      const layer=document.createElement('div');layer.className='generation-surface';layer.style.clipPath=`url(#${id})`;layer.dataset.surface=surface.id;layer.style.setProperty('--surface-delay',delay);
      const glow=document.createElement('div');glow.className='generation-glow';
      // Each selected region gets a full sweep, including small regions near the top of the photo.
      const field=document.createElement('div');field.className='generation-scan-field';const bounds=visibleBounds(surface.quad);for(const[key,value]of Object.entries(bounds))field.style[key]=`${value*100}%`;
      const scan=document.createElement('div');scan.className='generation-scan';field.append(scan);layer.append(glow,field);layers.push(layer);
      const outline=node('path',{d:pathFor(surface.quad,1000),class:'generation-outline','vector-effect':'non-scaling-stroke','data-surface':surface.id});outline.style.setProperty('--surface-delay',delay);boundaries.append(outline);
      if(surface.exclusions?.length)boundaries.append(node('path',{d:surface.exclusions.map(points=>pathFor(points,1000)).join(''),class:'generation-protection-outline','vector-effect':'non-scaling-stroke'}));
      const tile=tiles.find(item=>item.id===surface.tileId),assignment=document.createElement('div');assignment.className='generation-assignment';assignment.dataset.surface=surface.id;
      const image=document.createElement('img');image.className='generation-swatch';image.src=tile?.src||'';image.alt='';const copy=document.createElement('div'),face=document.createElement('span'),material=document.createElement('strong');
      face.textContent=`${index+1} · ${uiSurfaceLabel(surface)}`;material.className='generation-product';material.textContent=tile?uiTileName(tile):surface.tileId;copy.append(face,material);assignment.append(image,copy);assignments.push(assignment);
    });
    this.surfaces.replaceChildren(definitions,...layers,boundaries);this.materials.replaceChildren(...assignments);this.root.dataset.surfaceCount=String(surfaces.length);
  }
  show({token,roomSrc,surfaces,tiles,demo,label,detail,elapsedMs}){
    clearTimeout(this.hideTimer);
    if(this.token!==token){this.token=token;this.room.src=roomSrc;this.buildSurfaces(surfaces,tiles);this.root.dataset.demo=String(Boolean(demo));const indicator=document.createElement('i');indicator.setAttribute('aria-hidden','true');const text=document.createElement('span');text.textContent=demo?'Animation preview':'Generating your space';this.label.replaceChildren(indicator,text);}
    this.visible=true;this.root.hidden=false;this.root.classList.remove('is-leaving');this.root.classList.add('is-active');this.title.textContent=label;this.detail.textContent=detail;this.tick(elapsedMs,demo);
  }
  tick(ms,demo=false){if(!this.visible)return;const seconds=Math.max(0,Math.floor(ms/1000));this.elapsed.textContent=`${demo?'Preview':'Elapsed'} ${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;}
  hide({reveal=false}={}){
    if(!this.visible)return;this.visible=false;clearTimeout(this.hideTimer);this.root.classList.remove('is-active');
    if(reveal&&!matchMedia('(prefers-reduced-motion: reduce)').matches){this.root.classList.add('is-leaving');this.hideTimer=setTimeout(()=>{this.root.hidden=true;this.root.classList.remove('is-leaving');},650);}else{this.root.hidden=true;this.root.classList.remove('is-leaving');}
  }
  destroy(){clearTimeout(this.hideTimer);this.visible=false;this.token=null;this.root.hidden=true;this.root.classList.remove('is-active','is-leaving');this.surfaces.replaceChildren();this.materials.replaceChildren();}
}
