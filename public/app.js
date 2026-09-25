// Public candidate: local non-AI preview only. Legacy AI UI helpers below are inactive.
import { MultiSurfaceRenderer } from './renderer.js';
import { WaitingMotion } from './waiting-motion.js';
import { normalizeQuadWinding } from './quad-geometry.js';
import { SubmissionStore, RECOVERY_TTL_MS, freezeSnapshot, requestId, safeRecovery, retryDelay } from './request-recovery.js';
import { uiSurfaceLabel, uiTileName, uiRoomName, uiCaseName, uiCaseNotes, uiDisplayText, uiErrorMessage, uiRegionCount } from './ui-copy-en.js';
const DEFAULT_SETTINGS=Object.freeze({groutColor:'#d6d0c5',groutMm:3,rotation:0,layout:'straight',scale:1});
const DEFAULT_QUADS={floor:[[.25,.52],[.75,.52],[.97,.95],[.03,.95]],wall:[[.12,.13],[.49,.13],[.49,.65],[.12,.65]],splashback:[[.3,.36],[.78,.36],[.78,.57],[.3,.57]]};
const KIND_NAMES={floor:'地面',wall:'墙面',splashback:'防溅墙'},UI_KIND_NAMES={floor:'Floor',wall:'Wall',splashback:'Splashback'},SURFACE_COLOURS=['#3a7957','#af7447','#4b7ea0','#886991'];
const $=id=>document.getElementById(id),all=selector=>[...document.querySelectorAll(selector)];
const metrics=window.pilotMetrics={readyMs:null,renders:[],uploads:[],errors:[]};
const state={catalog:null,activeCaseId:null,room:null,roomImage:null,customRoom:null,surfaces:[],activeId:null,roomDrafts:new Map(),tileImages:new Map(),imagePromises:new Map(),renderer:null,mode:'original',previousMode:'original',edit:null,loading:true,renderTask:null,renderPending:false,renderTrigger:'initial',renderVersion:0,lastRender:null,aiCache:new Map(),lastAI:null,health:null,job:null,jobTimer:null,pollTimer:null,toastTimer:null,motionDemo:null,motionDemoTimer:null,tool:'select',spacePan:false,pan:null,ignoreClickUntil:0,inspectorOpen:true,history:null,historyMerge:null,viewport:{zoom:1,x:0,y:0,width:0,height:0,photoWidth:0},viewportFrame:0};
const waitingMotion=new WaitingMotion($('generationVisual')),submissionStore=new SubmissionStore();let renderFrame=0,surfaceSequence=0;
Object.assign(state,{recoveryCandidate:null,recoveryLoaded:false,recoveryRestoreKey:null});
const clonePoints=points=>(points||[]).map(point=>[Number(Array.isArray(point)?point[0]:point.x),Number(Array.isArray(point)?point[1]:point.y)]);
const clonePolygons=(polygons=[])=>polygons.map(clonePoints),activeSurface=()=>state.surfaces.find(surface=>surface.id===state.activeId)||state.surfaces[0],tileFor=(surface=activeSurface())=>state.catalog?.tiles.find(tile=>tile.id===surface?.tileId),pendingCalibration=()=>state.surfaces.some(surface=>surface._needsCalibration),finite=value=>typeof value==='number'&&Number.isFinite(value),jobIsActive=()=>Boolean(state.job&&['submitting','queued','running','cancelling'].includes(state.job.status));
const jobIsUncertain=(job=state.job)=>Boolean(job&&(['reconnecting','status_paused'].includes(job.status)||(!['done','result_failed','result_loading'].includes(job.status)&&job.recovery?.executionState==='uncertain'))),jobBlocksGeneration=()=>jobIsActive()||jobIsUncertain()||Boolean(state.job?.checking||state.job?.resultLoading||state.job?.actionBusy)||remainingRetry(state.job)>0;
function normaliseSettings(settings={}){return{groutColor:String(settings.groutColor??DEFAULT_SETTINGS.groutColor).toLowerCase(),groutMm:Number(settings.groutMm??3),rotation:Number(settings.rotation??0),layout:settings.layout??'straight',scale:Number(settings.scale??1)};}
function canonicalSurface(surface){const kind=surface.kind||'floor';return{id:String(surface.id),label:String(surface.label||KIND_NAMES[kind]).trim(),kind,tileId:String(surface.tileId),quad:clonePoints(surface.quad),exclusions:clonePolygons(surface.exclusions),settings:normaliseSettings(surface.settings),planeWidthMm:Number(surface.planeWidthMm||(kind==='floor'?4200:3600)),planeDepthMm:Number(surface.planeDepthMm||(kind==='floor'?4000:2600))};}
const canonicalSurfaces=(surfaces=state.surfaces)=>surfaces.map(canonicalSurface),cloneEditable=surfaces=>surfaces.map(surface=>({...canonicalSurface(surface),_presetCount:surface._presetCount||0,_needsCalibration:Boolean(surface._needsCalibration),_customLabel:Boolean(surface._customLabel)})),fingerprint=(roomId,surfaces)=>JSON.stringify([roomId,canonicalSurfaces(surfaces)]),currentKey=()=>state.room?fingerprint(state.room.id,state.surfaces):null,matchingAI=()=>state.aiCache.get(currentKey())||null;
function roomSurfaces(room){
  if(room.uploaded && Array.isArray(room.surfaces) && !room.surfaces.length)return[];
  const sources=Array.isArray(room.surfaces)&&room.surfaces.length?room.surfaces:[{id:'floor-1',label:'地面',kind:'floor',tileId:state.catalog.tiles[0].id,quad:room.quad||DEFAULT_QUADS.floor,exclusions:room.exclusions||[],settings:DEFAULT_SETTINGS,planeWidthMm:room.planeWidthMm,planeDepthMm:room.planeDepthMm}];
  return sources.slice(0,4).map(surface=>({...canonicalSurface({...surface,tileId:surface.tileId||state.catalog.tiles[0].id}),_presetCount:surface.exclusions?.length||0,_needsCalibration:Boolean(room.uploaded)}));
}
function duration(ms,precise=false){if(!finite(ms))return'Not recorded';if(ms<1000)return`${Math.max(0,ms).toFixed(precise?1:0)} ms`;if(ms<60000)return`${(ms/1000).toFixed(precise?2:1)} s`;return`${Math.floor(ms/60000)} min ${Math.floor(ms%60000/1000)} s`;}
function readableError(error,fallback='Could not complete this action. Please try again.'){if(['AbortError','TimeoutError'].includes(error?.name))return'The connection timed out. Check the local service and try again.';if(error instanceof TypeError&&/fetch|network/i.test(error.message))return'Cannot connect to the local service. Check that it is still running.';return uiErrorMessage(error?.message,fallback);}
function toast(message,error=false){clearTimeout(state.toastTimer);$('toast').textContent=message;$('toast').dataset.error=String(error);$('toast').hidden=false;state.toastTimer=setTimeout(()=>{$('toast').hidden=true;},error?7500:4500);}
function globalMessage(message=''){$('globalMessage').textContent=message;$('globalMessage').hidden=!message;}
async function jsonRequest(url,options={}){if(!/^\/api\/(catalog|health|validate|generate|jobs|requests)(?:\/|$)/.test(url))throw new Error('Unsupported local API path.');const response=await fetch(url,{cache:'no-store',...options});if(response.status===204)return{};let body;try{body=await response.json();}catch{const error=new Error(`The local service returned an unreadable response (HTTP ${response.status}).`);error.status=response.status;throw error;}if(!response.ok){const error=new Error(typeof body.error==='string'?body.error:body.error?.message||body.message||`The request failed (HTTP ${response.status}).`);error.status=response.status;error.errorCode=body.errorCode;error.recovery=body.recovery;throw error;}return body;}
function loadImage(src){return new Promise((resolve,reject)=>{const image=new Image();image.decoding='async';image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('The image could not load. Refresh the samples or choose another photo.'));image.src=src;});}
async function ensureTiles(surfaces){await Promise.all([...new Set(surfaces.map(surface=>surface.tileId))].map(async id=>{if(state.tileImages.has(id))return;const tile=state.catalog.tiles.find(item=>item.id===id);if(!tile)throw new Error(`Tile unavailable for this region: ${id}`);if(!state.imagePromises.has(id))state.imagePromises.set(id,loadImage(tile.src));try{const image=await state.imagePromises.get(id);state.tileImages.set(id,{image,widthMm:tile.widthMm,heightMm:tile.heightMm});}catch(error){state.imagePromises.delete(id);throw error;}}));return state.tileImages;}
function setSceneBusy(value,text='Preparing room and tile textures…'){state.loading=value;$('stage').setAttribute('aria-busy',String(value));$('sceneLoading').hidden=!value;$('sceneLoading').lastElementChild.textContent=text;updateDisabledState();}
function updateDisabledState(){
  const noScene=state.loading||!state.room,noSelection=noScene||!activeSurface(),editing=Boolean(state.edit),locked=noSelection||editing;
  all('.tile-option,.surface-option,.surface-map-label,input[name="layout"],input[name="rotation"],#scaleInput,#groutInput,#groutColor,.colour-swatch,#surfaceName,#surfaceKind').forEach(input=>{input.disabled=locked;});
  all('.room-option,#testCaseSelect,#roomUpload').forEach(input=>{input.disabled=noScene||editing;});
  if($('roomUpload'))$('roomUpload').disabled=state.loading||editing;
  document.querySelector('.upload-button')?.setAttribute('aria-disabled',String(state.loading||editing));
  $('newSurfaceKind').disabled=noScene||editing;
  $('calibrateButton').disabled=locked;$('resetButton').disabled=noScene||editing;
  $('addSurface').disabled=noScene||state.surfaces.length>=4;$('drawRectangle').disabled=noScene||state.surfaces.length>=4;
  $('deleteSurface').disabled=locked;
  const index=state.surfaces.findIndex(surface=>surface.id===state.activeId);
  $('moveSurfaceBack').disabled=locked||index<=0;$('moveSurfaceForward').disabled=locked||index>=state.surfaces.length-1;
  $('drawProtection').disabled=noSelection||(activeSurface()?.exclusions.length||0)>=12||Boolean(activeSurface()?._needsCalibration);
  $('clearProtections').disabled=locked||!activeSurface()||activeSurface().exclusions.length<=activeSurface()._presetCount;
  all('.remove-protection').forEach(button=>{button.disabled=locked;});
  $('generateButton').disabled=locked||pendingCalibration()||jobBlocksGeneration()||Boolean(state.recoveryCandidate)||!state.recoveryLoaded||!state.health?.proxyReachable;
  $('previewMotion').disabled=locked||jobIsActive();
  $('downloadButton').disabled=noScene||editing||(state.mode!=='original'&&(noSelection||(['ai','compare'].includes(state.mode)?!matchingAI():!state.lastRender||pendingCalibration())));
  all('.view-tabs button').forEach(button=>{button.disabled=(editing&&button.dataset.view!=='original')||(!state.surfaces.length&&button.dataset.view==='programmatic');});
  $('undoProtectionPoint').disabled=!state.edit?.points?.length;
  for(const id of ['selectTool','panTool','zoomIn','zoomOut','zoomFit'])$(id).disabled=noScene;
  $('quickMaterial').disabled=locked;$('quickAdjust').disabled=locked;$('quickDelete').disabled=locked;
  updateEditorChrome();
}

function caseSurfaces(testCase){if(!Array.isArray(testCase.surfaces)||testCase.surfaces.length<1||testCase.surfaces.length>4)throw new Error('A preset must contain 1 to 4 complete regions.');return testCase.surfaces.map(surface=>({...canonicalSurface(surface),_presetCount:surface.exclusions?.length||0,_needsCalibration:false}));}
function renderCaseOptions(){const cases=state.catalog.testCases||[];$('testCaseControl').hidden=!cases.length;const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Custom room and regions';$('testCaseSelect').replaceChildren(placeholder,...cases.map(testCase=>{const option=document.createElement('option');option.value=testCase.id;option.textContent=uiCaseName(testCase);return option;}));$('testCaseSelect').value=state.activeCaseId||'';}
function updateCaseDetails(){const testCase=(state.catalog?.testCases||[]).find(item=>item.id===state.activeCaseId);$('testCaseSelect').value=testCase?.id||'';$('testCaseStatus').textContent=testCase?(currentKey()===fingerprint(testCase.roomId,testCase.surfaces)?'Preset':'Modified'):'';const notes=uiCaseNotes(testCase);$('testCaseNotes').textContent=notes;$('testCaseNotes').hidden=!notes;}
async function selectTestCase(id){if(state.loading&&state.room)return;const testCase=(state.catalog.testCases||[]).find(item=>item.id===id);if(!testCase){if(!id&&state.room){state.activeCaseId=null;updateCaseDetails();return;}toast('This preset could not be found.',true);return;}const room=state.catalog.rooms.find(item=>item.id===testCase.roomId);if(!room){toast('The room for this preset has not loaded.',true);return;}await selectRoom(room,{testCase});}

function renderRoomOptions(){const rooms=state.customRoom?[...state.catalog.rooms,state.customRoom]:state.catalog.rooms;$('roomOptions').replaceChildren(...rooms.map(room=>{const button=document.createElement('button');button.className='room-option';button.type='button';button.dataset.room=room.id;button.setAttribute('aria-pressed',String(room.id===state.room?.id));const image=document.createElement('img');image.src=room.thumbnailSrc||room.src;image.alt='';image.width=64;image.height=48;image.loading='lazy';const name=document.createElement('span');name.className='option-name';name.textContent=uiRoomName(room);const note=document.createElement('small');note.textContent=room.uploaded?'My photo':room.synthetic?'Drawn demo room':'Sample room';name.append(note);button.append(image,name);button.addEventListener('click',()=>{void selectRoom(room);});return button;}));updateDisabledState();}
function renderTileOptions(){$('tileOptions').replaceChildren(...state.catalog.tiles.map(tile=>{const button=document.createElement('button');button.className='tile-option';button.type='button';button.dataset.tile=tile.id;const image=document.createElement('img');image.src=tile.src;image.alt=`${uiTileName(tile)} demo texture`;image.width=96;image.height=96;const name=document.createElement('span');name.className='option-name';name.textContent=uiTileName(tile);button.append(image,name);button.addEventListener('click',()=>{const surface=activeSurface();if(!surface||state.edit)return;surface.tileId=tile.id;surfacesChanged('material-change');});return button;}));}
function renderSurfaceOptions(){$('surfaceCount').textContent=`${state.surfaces.length} / 4`;$('surfaceOptions').replaceChildren(...state.surfaces.map((surface,index)=>{const button=document.createElement('button');button.type='button';button.className='surface-option';button.dataset.surface=surface.id;button.style.setProperty('--surface-colour',SURFACE_COLOURS[index]);button.setAttribute('aria-pressed',String(surface.id===state.activeId));const number=document.createElement('span');number.className='surface-number';number.textContent=index+1;const text=document.createElement('span');text.className='surface-option-copy';const name=document.createElement('strong');name.textContent=uiSurfaceLabel(surface);const note=document.createElement('small');note.textContent=surface._needsCalibration?'Adjust the corners first':uiTileName(tileFor(surface))||'Tile unavailable';text.append(name,note);button.append(number,text);button.addEventListener('click',()=>selectSurface(surface.id));return button;}));}
function renderAssignments(){$('surfaceAssignmentStrip').replaceChildren(...state.surfaces.map((surface,index)=>{const button=document.createElement('button');button.type='button';button.className='assignment-item';button.style.setProperty('--surface-colour',SURFACE_COLOURS[index]);button.setAttribute('aria-pressed',String(surface.id===state.activeId));const dot=document.createElement('i');dot.setAttribute('aria-hidden','true');const label=document.createElement('span');label.textContent=`${uiSurfaceLabel(surface)} · ${uiTileName(tileFor(surface))||surface.tileId}`;button.append(dot,label);button.disabled=Boolean(state.edit)||state.loading;button.addEventListener('click',()=>selectSurface(surface.id));return button;}));}
function renderProtectionList(){const surface=activeSurface();if(!surface)return;if(!surface.exclusions.length){const empty=document.createElement('p');empty.className='field-note protection-empty';empty.textContent='This region has no protected areas.';$('protectionList').replaceChildren(empty);return;}$('protectionList').replaceChildren(...surface.exclusions.map((polygon,index)=>{const row=document.createElement('div');row.className='protection-item';const text=document.createElement('span');const preset=index<surface._presetCount;text.textContent=`${preset?'Preset protection':'Custom protection'} ${preset?index+1:index-surface._presetCount+1} · ${polygon.length} points`;row.append(text);if(preset){const badge=document.createElement('small');badge.textContent='Keep';row.append(badge);}else{const button=document.createElement('button');button.type='button';button.className='text-button remove-protection';button.textContent='Delete';button.setAttribute('aria-label',`Delete custom protected area ${index-surface._presetCount+1}`);button.addEventListener('click',()=>{if(state.edit||state.loading)return;surface.exclusions.splice(index,1);surfacesChanged('protection-delete');});row.append(button);}return row;}));}
function syncSettingsControls(){const surface=activeSurface();if(!surface)return;const settings=surface.settings;all('input[name="layout"]').forEach(input=>{input.checked=input.value===settings.layout;});all('input[name="rotation"]').forEach(input=>{input.checked=Number(input.value)===settings.rotation;});$('scaleInput').value=settings.scale;$('scaleOutput').textContent=`${settings.scale.toFixed(2)}×`;$('groutInput').value=settings.groutMm;$('groutOutput').textContent=`${settings.groutMm} mm`;$('groutColor').value=settings.groutColor;$('groutHex').textContent=settings.groutColor.toUpperCase();all('[data-colour]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.colour===settings.groutColor)));}
function updateCurrentControls({keepName=false}={}){
  const surface=activeSurface();$('inspectorEmpty').hidden=Boolean(surface);
  if(!surface){$('surfaceName').value='';$('activeSurfaceName').textContent='No region selected';$('tileDetails').replaceChildren();$('protectionList').replaceChildren();$('calibrationSummary').textContent='Use a drawing tool to mark the first tiled region.';all('.tile-option').forEach(button=>button.setAttribute('aria-pressed','false'));updateDisabledState();return;}
  const tile=tileFor(surface),index=state.surfaces.indexOf(surface);if(!keepName)$('surfaceName').value=uiSurfaceLabel(surface);
  $('surfaceKind').value=surface.kind;$('activeSurfaceName').textContent=`${index+1} · ${uiSurfaceLabel(surface)}`;$('activeSurfaceName').style.setProperty('--surface-colour',SURFACE_COLOURS[index]);
  all('.tile-option').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.tile===surface.tileId)));
  const dimensions=document.createElement('strong');dimensions.textContent=tile?`${tile.widthMm} × ${tile.heightMm} mm`:'Tile details unavailable';const identifier=document.createElement('span');identifier.textContent=tile?.sku?`SKU ${tile.sku}`:'Synthetic demo texture';$('tileDetails').replaceChildren(dimensions,identifier);
  $('calibrationSummary').textContent=surface._needsCalibration?`Adjust the four corners of ${uiSurfaceLabel(surface)} first.`:`Editing ${uiSurfaceLabel(surface)}`;
  syncSettingsControls();renderProtectionList();updateDisabledState();
}
function updateRoomDetails(){all('.room-option').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.room===state.room.id)));$('sourceNote').textContent=uiDisplayText(state.room.sourceNote)||(state.room.synthetic?'This is a schematic demo, not a photograph.':'');$('originalImage').src=state.room.src;$('aiBaseImage').src=state.room.src;$('originalImage').alt=`${uiRoomName(state.room)}, original unedited room image`;$('originalCaption').textContent=state.room.synthetic?'Drawn demo room · Select a region to edit':state.room.uploaded?'My photo · Select a region to edit':'Sample photo · Select a region to edit';$('stage').style.setProperty('--scene-ratio',`${state.roomImage.naturalWidth} / ${state.roomImage.naturalHeight}`);$('imageResolution').textContent=`${state.roomImage.naturalWidth} × ${state.roomImage.naturalHeight} px`;}
function polygonPath(points){return points.length?`M${points.map(([x,y])=>`${x*1000},${y*1000}`).join('L')}Z`:'';}
function svgElement(name,attributes={}){const element=document.createElementNS('http://www.w3.org/2000/svg',name);Object.entries(attributes).forEach(([key,value])=>element.setAttribute(key,String(value)));return element;}
function drawSurfaceMap(){const paths=[],labels=[];state.surfaces.forEach((surface,index)=>{const selected=surface.id===state.activeId,colour=SURFACE_COLOURS[index];const path=svgElement('path',{d:polygonPath(surface.quad)+surface.exclusions.map(polygonPath).join(''),'fill-rule':'evenodd',fill:colour,stroke:colour,'stroke-width':selected?3:1.5,'vector-effect':'non-scaling-stroke',class:`surface-map-path${selected?' is-active':''}`,'data-surface':surface.id});path.addEventListener('click',()=>{if(!state.edit)selectSurface(surface.id);});path.addEventListener('dblclick',event=>{if(state.edit||state.tool==='pan'||state.spacePan)return;event.preventDefault();selectSurface(surface.id);beginQuadEdit();});paths.push(path);surface.exclusions.forEach((polygon,protectionIndex)=>paths.push(svgElement('path',{d:polygonPath(polygon),fill:'#fff',stroke:colour,'stroke-width':1.4,'stroke-dasharray':'5 4','vector-effect':'non-scaling-stroke',class:'protection-map-path','data-preset':String(protectionIndex<surface._presetCount)})));const centre=surface.quad.reduce((value,point)=>[value[0]+point[0]/4,value[1]+point[1]/4],[0,0]);const button=document.createElement('button');button.type='button';button.className='surface-map-label';button.style.left=`${Math.min(.83,Math.max(.12,centre[0]))*100}%`;button.style.top=`${Math.min(.88,Math.max(.1,centre[1]))*100}%`;button.style.setProperty('--surface-colour',colour);button.textContent=String(index+1);button.title=`${index+1} ${uiSurfaceLabel(surface)}`;button.setAttribute('aria-label',`Select region ${index+1}: ${uiSurfaceLabel(surface)}`);button.setAttribute('aria-pressed',String(selected));button.disabled=Boolean(state.edit);button.addEventListener('click',()=>selectSurface(surface.id));labels.push(button);});$('surfacePolygons').replaceChildren(...paths);$('surfaceLabels').replaceChildren(...labels);$('surfaceOverlay').dataset.editing=String(Boolean(state.edit));}
function saveDraft(){if(state.room)state.roomDrafts.set(state.room.id,{surfaces:cloneEditable(state.surfaces),activeId:state.activeId});}
function selectSurface(id){
  if(state.edit||state.loading||performance.now()<state.ignoreClickUntil||!state.surfaces.some(surface=>surface.id===id))return;
  state.activeId=id;state.tool='select';state.historyMerge=null;if(state.history)state.history.entries[state.history.index].activeId=id;
  saveDraft();setInspector(true);renderSurfaceOptions();renderAssignments();updateCurrentControls();drawSurfaceMap();
}
function surfacesChanged(trigger,{keepName=false,history=true,mergeKey=null}={}){
  if(history)recordHistory(mergeKey);
  if(!state.surfaces.length||pendingCalibration()){$('tileCanvas').hidden=true;state.lastRender=null;$('renderCaption').textContent=state.surfaces.length?'New region needs corner adjustment':'Draw a region to see the tile preview';}
  stopMotionPreview({quiet:true});saveDraft();renderSurfaceOptions();renderAssignments();updateCurrentControls({keepName});updateCaseDetails();drawSurfaceMap();updateAIResult();
  if(!state.surfaces.length&&state.mode==='programmatic')setView('original');
  if(state.surfaces.length)scheduleRender(trigger);
}
function changeSettings(patch,{mergeKey=null}={}){const surface=activeSurface();if(!surface||state.edit)return;surface.settings=normaliseSettings({...surface.settings,...patch});surfacesChanged('settings-change',{mergeKey:mergeKey?`${surface.id}:${mergeKey}`:null});}
async function selectRoom(room,{reset=false,testCase=null}={}){
  if(!room||(state.loading&&state.room))return;
  if(state.room?.id===room.id&&!reset&&!testCase&&!state.activeCaseId){closeRoomDrawer();return;}
  stopMotionPreview({quiet:true});if(state.edit)finishEdit();saveDraft();setSceneBusy(true);globalMessage();
  try{
    if(state.renderTask)await state.renderTask;
    const image=state.room?.id===room.id&&state.roomImage?state.roomImage:await loadImage(room.src);
    const draft=!reset&&!testCase&&state.roomDrafts.get(room.id),surfaces=testCase?caseSurfaces(testCase):draft?cloneEditable(draft.surfaces):roomSurfaces(room);
    if(surfaces.length>4)throw new Error('A room can have up to 4 regions.');
    if(surfaces.length)await ensureTiles(surfaces);
    await state.renderer.setScene({image});
    state.room=room;state.activeCaseId=testCase?.id||null;state.roomImage=image;state.surfaces=surfaces;
    state.activeId=draft?.activeId&&surfaces.some(surface=>surface.id===draft.activeId)?draft.activeId:surfaces[0]?.id||null;
    state.lastRender=null;$('tileCanvas').hidden=true;state.tool='select';state.spacePan=false;state.viewport.zoom=1;state.viewport.x=state.viewport.y=0;
    seedHistory();updateRoomDetails();updateCaseDetails();renderSurfaceOptions();renderAssignments();updateCurrentControls();drawSurfaceMap();saveDraft();setSceneBusy(false);setView('original');closeRoomDrawer();fitViewport();
    if(surfaces.length&&!pendingCalibration())await renderNow(reset?'reset':'room-change');
    if(metrics.readyMs===null){metrics.readyMs=performance.now();$('readyTime').textContent=duration(metrics.readyMs,true);performance.mark('pilot-ready');}
  }catch(error){setSceneBusy(false);metrics.errors.push({at:performance.now(),context:'select-room',message:readableError(error)});globalMessage(readableError(error));}
}
function renderNow(trigger='settings-change'){if(!state.renderer||!state.room||!state.surfaces.length||state.loading||state.edit||pendingCalibration())return Promise.resolve();if(state.renderTask){state.renderPending=true;state.renderTrigger=trigger;return state.renderTask;}const key=currentKey(),surfaces=canonicalSurfaces(),version=++state.renderVersion;const task=(async()=>{try{const tiles=await ensureTiles(surfaces),started=performance.now();await state.renderer.setSurfaces({surfaces,tiles});const preparedAt=performance.now(),result=await state.renderer.render(),returnedAt=performance.now();const entry={...result,durationMs:finite(result?.durationMs)?result.durationMs:returnedAt-preparedAt,prepareMs:preparedAt-started,clientDurationMs:returnedAt-started,at:returnedAt,trigger,version,key,surfaceCount:surfaces.length};metrics.renders.push(entry);if(key!==currentKey()||state.loading)return;state.lastRender=entry;$('tileCanvas').hidden=false;$('renderTime').textContent=duration(entry.durationMs,true);$('renderCaption').textContent=`${uiRegionCount(surfaces.length)} · ${duration(entry.durationMs,true)}`;updateDisabledState();}catch(error){metrics.errors.push({at:performance.now(),context:'render',message:readableError(error)});$('tileCanvas').hidden=true;$('renderCaption').textContent='Tile preview unavailable';globalMessage(`Tile preview unavailable: ${readableError(error)}`);}})();state.renderTask=task;void task.finally(()=>{state.renderTask=null;if(state.renderPending){state.renderPending=false;scheduleRender(state.renderTrigger);}});return task;}
function scheduleRender(trigger='settings-change'){state.renderTrigger=trigger;if(renderFrame)return;renderFrame=requestAnimationFrame(()=>{renderFrame=0;void renderNow(state.renderTrigger);});}
function setView(mode){if(!['original','programmatic','ai','compare'].includes(mode))return;
  if(state.edit&&mode!=='original')return;if(!state.surfaces.length&&mode==='programmatic')mode='original';
  const changed=state.mode!==mode;state.mode=mode;$('stage').dataset.mode=mode;
  $('renderPanel').hidden=!['programmatic','compare'].includes(mode);$('aiPanel').hidden=!['ai','compare'].includes(mode);$('originalPanel').hidden=mode!=='original';
  all('[data-view]').forEach(button=>{const selected=button.dataset.view===mode;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;});
  $('downloadButton').textContent=mode==='original'?'Download original':mode==='programmatic'?'Download tile preview':'Download AI result';
  $('previewNote').textContent=mode==='original'?'Select a region to choose tiles. Double-click to adjust its corners. Dashed areas keep the original photo.':mode==='programmatic'?'Shows tile textures in your selected areas. This is not an AI-generated result.':mode==='compare'?'Tile preview uses a non-AI texture overlay. The AI result is generated separately.':'Use the AI result as a visual guide. Check the product details and physical samples.';
  if(changed){state.viewport.zoom=1;state.viewport.x=state.viewport.y=0;}
  layoutViewport();updateAIResult();updateDisabledState();
}
function addExamples(catalog){let count=0;for(const example of catalog.examples||[]){const room=catalog.rooms.find(item=>item.id===example.roomId);if(!room||!example.url)continue;let surfaces;if(Array.isArray(example.surfaces)&&example.surfaces.length)surfaces=canonicalSurfaces(example.surfaces);else{const defaults=roomSurfaces(room);if(defaults.length!==1||!example.tileId)continue;surfaces=[canonicalSurface({...defaults[0],tileId:example.tileId,settings:example.settings,quad:example.quad||defaults[0].quad,exclusions:example.exclusions||defaults[0].exclusions})];}const key=fingerprint(room.id,surfaces);if(state.aiCache.get(key)?.kind==='generated')continue;state.aiCache.set(key,{...example,surfaces,key,kind:'sample',roomName:room.name});count++;}return count;}
function updateAIResult(){const match=matchingAI(),previous=state.lastAI;if(match){if(['ai','compare'].includes(state.mode)&&$('aiImage').getAttribute('src')!==(match.displayUrl||match.url))$('aiImage').src=match.displayUrl||match.url;$('aiImage').hidden=false;$('aiEmpty').hidden=true;$('aiCaption').textContent=`${match.kind==='sample'?'Saved AI sample':'Generated result'} · ${uiRegionCount(match.surfaces.length)} · ${duration(match.elapsedMs)}`;$('aiTime').textContent=duration(match.elapsedMs);$('comparisonNotice').hidden=true;state.lastAI=match;}else{$('aiImage').hidden=true;$('aiImage').removeAttribute('src');$('aiEmpty').hidden=false;$('aiCaption').textContent='Original photo · No AI result for this design';$('aiTime').textContent='Not generated';const mismatch=previous&&previous.key!==currentKey();$('aiEmptyTitle').textContent=mismatch?'Your design has changed. Generate a new result.':'Choose tiles for each region, then generate the room';$('aiEmptyText').textContent=!state.surfaces.length?'Draw at least one tiled region on the photo first.':pendingCalibration()?'Adjust the four corners of each new region first.':'Check the regions and protected areas on the original photo, then generate the whole room.';const show=Boolean(mismatch&&['ai','compare'].includes(state.mode));$('comparisonNotice').hidden=!show;$('comparisonNotice').textContent=show?'The previous AI image is hidden because it does not match this design. Generate again after changing any tile, setting, name, layer order, outline or protected area.':'';}$('generateButton').textContent=jobIsActive()?'Generating…':match?'Generate again':'Generate AI result';updateWaitingVisual();updateDisabledState();updateJobActions();}
function addSurface(){beginNewRegion('new-quad');}
function removeSurface(){
  if(state.edit||state.loading||!activeSurface())return;
  const index=state.surfaces.findIndex(surface=>surface.id===state.activeId),name=uiSurfaceLabel(activeSurface());
  state.surfaces.splice(index,1);state.activeId=state.surfaces[Math.min(index,state.surfaces.length-1)]?.id||null;
  surfacesChanged('surface-remove');if(!state.surfaces.length)setView('original');toast(`Deleted ${name}. Use Undo to restore it.`);
}
function moveSurface(delta){if(state.edit||state.loading)return;const index=state.surfaces.findIndex(surface=>surface.id===state.activeId),next=index+delta;if(next<0||next>=state.surfaces.length)return;[state.surfaces[index],state.surfaces[next]]=[state.surfaces[next],state.surfaces[index]];surfacesChanged('surface-order');}
function beginQuadEdit(){
  if(state.loading||!activeSurface())return;if(state.edit)cancelEdit();stopMotionPreview({quiet:true});state.previousMode=state.mode;
  state.edit={kind:'quad',surfaceId:state.activeId,quad:clonePoints(activeSurface().quad)};state.tool='adjust';
  setupEditUI();drawQuad();
  if(state.edit.quad.some(point=>point.some(n=>n<0||n>1)))fitViewport();
}
function beginProtection(){
  if(state.loading||!activeSurface()||activeSurface().exclusions.length>=12)return;if(state.edit)cancelEdit();stopMotionPreview({quiet:true});state.previousMode=state.mode;
  state.edit={kind:'protection',surfaceId:state.activeId,points:[],hover:null};state.tool='protection';setupEditUI();drawProtectionDraft();
}
function setupEditUI(){
  const kind=state.edit.kind,isQuad=kind==='quad',isProtection=kind==='protection',isNew=kind.startsWith('new-');
  $('calibrationInstructions').hidden=false;$('calibrationOverlay').hidden=!isQuad;$('protectionDrawingOverlay').hidden=!isProtection;$('newRegionOverlay').toggleAttribute('hidden',!isNew);
  $('newRegionOverlay').dataset.mode=kind;$('polygonPointCount').hidden=isQuad;$('undoProtectionPoint').hidden=isQuad||kind==='new-rectangle';
  $('editTitle').textContent=isQuad?`Adjust ${uiSurfaceLabel(activeSurface())}`:isProtection?`Protect objects in ${uiSurfaceLabel(activeSurface())}`:kind==='new-quad'?'Draw a four-corner region':'Draw a rectangle';
  $('editDescription').textContent=isQuad?'Drag a corner or use the arrow keys. Hold Shift for larger steps. Apply to save.':isProtection?'Click at least 3 points around the object. Enter to finish; Esc to cancel.':kind==='new-quad'?'Click four corners in order, in either direction. The fourth click saves. Esc to cancel.':'Drag a rectangle on the photo. Release to save; Esc to cancel.';
  $('applyCalibration').textContent=isQuad?'Apply outline':isProtection?'Save protected area':'Save region';
  setView('original');drawSurfaceMap();renderAssignments();updateDisabledState();
}
function drawQuad(){
  if(state.edit?.kind!=='quad')return;
  $('quadPolygon').setAttribute('points',state.edit.quad.map(([x,y])=>`${x*1000},${y*1000}`).join(' '));
  all('.quad-handle').forEach((button,index)=>{button.style.left=`${state.edit.quad[index][0]*100}%`;button.style.top=`${state.edit.quad[index][1]*100}%`;});
  $('applyCalibration').disabled=!quadValid(state.edit.quad);updateEditorChrome();
}
function drawProtectionDraft(){
  if(state.edit?.kind!=='protection')return;const points=state.edit.points,preview=state.edit.hover?[...points,state.edit.hover]:points;
  $('protectionDraftLine').setAttribute('points',preview.map(([x,y])=>`${x*1000},${y*1000}`).join(' '));
  $('protectionDraftDots').replaceChildren(...points.map(([x,y],index)=>{const group=svgElement('g'),dot=svgElement('circle',{cx:x*1000,cy:y*1000,r:7}),label=svgElement('text',{x:x*1000+11,y:y*1000-10});label.textContent=index+1;group.append(dot,label);return group;}));
  $('polygonPointCount').textContent=`${points.length} / 32 points`;$('applyCalibration').disabled=!polygonValid(points);$('undoProtectionPoint').disabled=!points.length;updateEditorChrome();
}
function cross(a,b,c){return(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);}
function segmentsIntersect(a,b,c,d){const p=cross(a,b,c),q=cross(a,b,d),r=cross(c,d,a),s=cross(c,d,b),epsilon=1e-8;if(((p>epsilon&&q< -epsilon)||(p< -epsilon&&q>epsilon))&&((r>epsilon&&s< -epsilon)||(r< -epsilon&&s>epsilon)))return true;const on=(x,y,z)=>Math.abs(cross(x,y,z))<epsilon&&z[0]>=Math.min(x[0],y[0])-epsilon&&z[0]<=Math.max(x[0],y[0])+epsilon&&z[1]>=Math.min(x[1],y[1])-epsilon&&z[1]<=Math.max(x[1],y[1])+epsilon;return on(a,b,c)||on(a,b,d)||on(c,d,a)||on(c,d,b);}
function polygonValid(points){if(points.length<3||points.length>32||points.some(point=>point.some(value=>!Number.isFinite(value))))return false;let area=0;for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length];if(Math.hypot(a[0]-b[0],a[1]-b[1])<.0001)return false;area+=a[0]*b[1]-b[0]*a[1];for(let j=i+1;j<points.length;j++){if(j===i+1||(i===0&&j===points.length-1))continue;if(segmentsIntersect(a,b,points[j],points[(j+1)%points.length]))return false;}}return Math.abs(area)>.00002;}
function quadValid(quad){return Boolean(normalizeQuadWinding(quad));}
function finishEdit(){
  state.edit=null;state.tool='select';$('calibrationInstructions').hidden=true;$('calibrationOverlay').hidden=true;$('protectionDrawingOverlay').hidden=true;$('newRegionOverlay').toggleAttribute('hidden',true);
  $('draftRegionPath').setAttribute('d','');$('draftRegionPoints').replaceChildren();$('applyCalibration').disabled=false;
  drawSurfaceMap();renderAssignments();updateDisabledState();
}
function applyEdit(){
  if(!state.edit)return;if(state.edit.kind.startsWith('new-')){commitNewRegion();return;}
  const surface=state.surfaces.find(item=>item.id===state.edit.surfaceId);if(!surface)return;
  if(state.edit.kind==='quad'){
    const quad=normalizeQuadWinding(state.edit.quad);
    if(!quad){toast('Place four corners around a convex shape in either direction. Edges must not cross.',true);return;}
    surface.quad=quad;surface._needsCalibration=false;finishEdit();surfacesChanged('calibration-apply');toast('Region outline saved.');
  }else{
    if(!polygonValid(state.edit.points)){toast('Use 3 to 32 points for a protected area. Edges must not cross.',true);return;}
    if(surface.exclusions.length>=12){toast('Each region can have up to 12 protected areas.',true);return;}
    surface.exclusions.push(clonePoints(state.edit.points));finishEdit();surfacesChanged('protection-add');toast('Protected area saved.');
  }
}
function cancelEdit(){if(!state.edit)return;finishEdit();updateAIResult();}

// Undo keeps only bounded geometry/material snapshots, never room image bytes.
function sceneSnapshot(){return{surfaces:cloneEditable(state.surfaces),activeId:state.activeId};}
function seedHistory(){state.history={entries:[sceneSnapshot()],index:0};state.historyMerge=null;}
function recordHistory(mergeKey=null){
  if(!state.history){seedHistory();return;}
  const history=state.history,next=sceneSnapshot(),current=history.entries[history.index];
  if(JSON.stringify(next.surfaces)===JSON.stringify(current.surfaces)){current.activeId=next.activeId;return;}
  const now=performance.now(),merge=mergeKey&&state.historyMerge?.key===mergeKey&&now-state.historyMerge.at<1000&&history.index===history.entries.length-1&&history.index>0;
  if(merge)history.entries[history.index]=next;
  else{history.entries.splice(history.index+1);history.entries.push(next);if(history.entries.length>80)history.entries.shift();history.index=history.entries.length-1;}
  state.historyMerge=mergeKey?{key:mergeKey,at:now}:null;
}
function restoreHistory(delta){
  if(state.loading||!state.history)return;if(state.edit){cancelEdit();return;}
  const history=state.history,index=history.index+delta;if(index<0||index>=history.entries.length)return;
  history.index=index;state.historyMerge=null;const snapshot=history.entries[index];state.surfaces=cloneEditable(snapshot.surfaces);
  state.activeId=state.surfaces.some(surface=>surface.id===snapshot.activeId)?snapshot.activeId:state.surfaces[0]?.id||null;
  surfacesChanged(delta<0?'undo':'redo',{history:false});
}
function setInspector(open,{focus=false}={}){
  state.inspectorOpen=Boolean(open);$('inspectorPanel').hidden=!open;document.body.dataset.inspector=open?'open':'closed';
  $('toggleInspector').setAttribute('aria-expanded',String(Boolean(open)));$('toggleInspector').setAttribute('aria-pressed',String(Boolean(open)));
  queueViewportLayout();if(focus&&open)requestAnimationFrame(()=>{$('tileOptions').querySelector('[aria-pressed="true"]')?.focus({preventScroll:true});});
}
function openRoomDrawer(){
  $('roomDrawer').hidden=false;if($('roomDrawerBackdrop'))$('roomDrawerBackdrop').hidden=false;
  $('showRooms').setAttribute('aria-expanded','true');$('closeRooms').focus({preventScroll:true});
}
function closeRoomDrawer({focus=false}={}){
  $('roomDrawer').hidden=true;if($('roomDrawerBackdrop'))$('roomDrawerBackdrop').hidden=true;
  $('showRooms').setAttribute('aria-expanded','false');if(focus)$('showRooms').focus({preventScroll:true});
}
function updateEditorChrome(){
  document.body.dataset.tool=state.spacePan?'pan':state.tool;
  const toolButtons={selectTool:'select',addSurface:'quad',drawRectangle:'rectangle',drawProtection:'protection',calibrateButton:'adjust',panTool:'pan'};
  Object.entries(toolButtons).forEach(([id,tool])=>{$(id)?.setAttribute('aria-pressed',String((state.spacePan?'pan':state.tool)===tool));});
  const noScene=state.loading||!state.room,history=state.history;
  $('undoAction').disabled=noScene||(!state.edit&&(!history||history.index===0));$('redoAction').disabled=noScene||Boolean(state.edit)||!history||history.index>=history.entries.length-1;
  $('surfaceQuickActions').hidden=noScene||!activeSurface()||Boolean(state.edit)||state.mode!=='original'||state.tool==='pan'||state.spacePan;
  $('canvasViewport').dataset.panning=String(Boolean(state.pan));
  const count=state.edit?.points?.length||0;
  $('editorHint').textContent=noScene?'Preparing photo…':state.spacePan||state.tool==='pan'?'Drag to pan · Scroll to zoom · V to select':state.edit?.kind==='new-quad'?`Click corners in either direction · ${count} / 4 · Esc to cancel`:state.edit?.kind==='new-rectangle'?'Drag a rectangle and release to save · Esc to cancel':state.edit?.kind==='protection'?`Click around the object · ${count} / 32 · Enter to finish · Esc to cancel`:state.edit?.kind==='quad'?'Drag corners · Arrow keys to adjust · Enter to apply · Esc to cancel':!state.surfaces.length?'Use Four corners or Rectangle to draw your first region':state.surfaces.length>=4?'4 regions selected · Click to choose tiles · Delete to remove a region':state.mode==='original'?'Select a region for tiles · Double-click for corners · Hold Space to pan':'Open Edit regions to make changes · Hold Space to pan';
}
function chooseTool(tool){
  if(state.loading||!state.room)return;
  if(tool==='quad'){beginNewRegion('new-quad');return;}if(tool==='rectangle'){beginNewRegion('new-rectangle');return;}
  if(tool==='protection'){beginProtection();return;}if(tool==='adjust'){beginQuadEdit();return;}
  if(state.edit)cancelEdit();state.tool=tool;state.spacePan=false;if(tool==='select')setView('original');updateEditorChrome();
}
function imagePoint(event,{clamp=true}={}){
  const rect=$('originalFrame').getBoundingClientRect();if(!rect.width||!rect.height)return null;
  const x=(event.clientX-rect.left)/rect.width,y=(event.clientY-rect.top)/rect.height;
  return clamp?[Math.min(1,Math.max(0,x)),Math.min(1,Math.max(0,y))]:[Math.min(3,Math.max(-2,x)),Math.min(3,Math.max(-2,y))];
}
function beginNewRegion(kind){
  if(state.loading||!state.room)return;if(state.surfaces.length>=4){toast('Maximum of 4 regions. Delete one before adding another.');return;}
  if(state.edit)cancelEdit();stopMotionPreview({quiet:true});const surface=activeSurface();
  state.edit={kind,points:[],hover:null,start:null,tileId:surface?.tileId||state.catalog.tiles[0].id,surfaceKind:$('newSurfaceKind').value||'wall',settings:normaliseSettings(surface?.settings)};
  state.tool=kind==='new-quad'?'quad':'rectangle';state.previousMode=state.mode;setupEditUI();drawNewRegion();
}
function rectanglePoints(start,end){return[[Math.min(start[0],end[0]),Math.min(start[1],end[1])],[Math.max(start[0],end[0]),Math.min(start[1],end[1])],[Math.max(start[0],end[0]),Math.max(start[1],end[1])],[Math.min(start[0],end[0]),Math.max(start[1],end[1])]];}
function drawNewRegion(){
  const edit=state.edit;if(!edit?.kind.startsWith('new-'))return;
  const points=edit.points,preview=edit.kind==='new-quad'&&points.length<4&&edit.hover?[...points,edit.hover]:points;
  const path=preview.length?`M${preview.map(([x,y])=>`${x*1000},${y*1000}`).join('L')}${points.length===4?'Z':''}`:'';
  $('draftRegionPath').setAttribute('d',path);$('draftRegionPath').dataset.valid=String(points.length===4&&quadValid(points));
  $('draftRegionPoints').replaceChildren(...points.map(([x,y],index)=>{const group=svgElement('g'),dot=svgElement('circle',{cx:x*1000,cy:y*1000,r:7,'vector-effect':'non-scaling-stroke'}),label=svgElement('text',{x:x*1000+11,y:y*1000-10});label.textContent=index+1;group.append(dot,label);return group;}));
  $('polygonPointCount').textContent=edit.kind==='new-quad'?`${points.length} / 4 corners`:'Drag to set the outline';
  $('applyCalibration').disabled=points.length!==4||!quadValid(points);$('undoProtectionPoint').disabled=!points.length;updateEditorChrome();
}
function commitNewRegion(){
  const edit=state.edit;if(!edit?.kind.startsWith('new-'))return;
  const quad=normalizeQuadWinding(edit.points);
  if(!quad){toast('Draw a convex shape in either direction. Use Undo point to adjust, or Esc to cancel.',true);return;}
  if(state.surfaces.length>=4){cancelEdit();return;}
  const kind=edit.surfaceKind,surface={...canonicalSurface({id:`surface-${Date.now()}-${++surfaceSequence}`,label:`${UI_KIND_NAMES[kind]} ${state.surfaces.filter(item=>item.kind===kind).length+1}`,kind,tileId:edit.tileId,quad,exclusions:[],settings:edit.settings}),_presetCount:0,_needsCalibration:false};
  state.surfaces.push(surface);state.activeId=surface.id;finishEdit();setInspector(true);surfacesChanged('surface-add');toast(`Added ${uiSurfaceLabel(surface)}. Choose a tile for this region.`);
}
function undoDraftPoint(){
  if(!state.edit?.points)return;state.edit.points.pop();state.edit.hover=null;
  if(state.edit.kind==='protection')drawProtectionDraft();else drawNewRegion();
}
function queueViewportLayout(){if(state.viewportFrame)return;state.viewportFrame=requestAnimationFrame(()=>{state.viewportFrame=0;layoutViewport();});}
function layoutViewport(){
  if(!state.roomImage)return;const viewport=$('canvasViewport'),content=$('canvasContent'),model=state.viewport,ratio=state.roomImage.naturalWidth/state.roomImage.naturalHeight;
  const columns=state.mode==='compare'?2:1,gap=columns===2?12:0,padding=28;
  const availableWidth=Math.max(100,viewport.clientWidth-padding),availableHeight=Math.max(100,viewport.clientHeight-padding);
  const height=Math.max(40,Math.min(availableHeight,(availableWidth-gap)/(ratio*columns))),photoWidth=height*ratio;
  const oldWidth=model.width,oldHeight=model.height;model.width=photoWidth*columns+gap;model.height=height;model.photoWidth=photoWidth;
  if(oldWidth&&oldHeight){model.x*=model.width/oldWidth;model.y*=model.height/oldHeight;}
  content.style.width=`${model.width}px`;content.style.height=`${model.height}px`;content.style.transformOrigin='0 0';
  $('stage').style.width='100%';$('stage').style.height='100%';$('stage').style.gridTemplateColumns=`repeat(${columns}, minmax(0, 1fr))`;$('stage').style.gap=`${gap}px`;
  all('#stage .preview-panel > .image-frame').forEach(frame=>{frame.style.width=`${photoWidth}px`;frame.style.height=`${height}px`;frame.style.aspectRatio='auto';});
  renderViewportTransform();
}
function renderViewportTransform(){
  const viewport=$('canvasViewport'),model=state.viewport;if(!model.width)return;
  const width=model.width*model.zoom,height=model.height*model.zoom,left=(viewport.clientWidth-width)/2+model.x,top=(viewport.clientHeight-height)/2+model.y;
  $('canvasContent').style.transform=`translate(${left}px, ${top}px) scale(${model.zoom})`;
  $('zoomValue').textContent=`${Math.round(model.zoom*100)}%`;updateEditorChrome();
}
function fitViewport(){
  state.viewport.zoom=1;state.viewport.x=state.viewport.y=0;layoutViewport();
  if(state.edit?.kind==='quad'){
    const points=[[0,0],[1,1],...state.edit.quad],xs=points.map(point=>point[0]),ys=points.map(point=>point[1]),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys),model=state.viewport,viewport=$('canvasViewport');
    model.zoom=Math.min(1,(viewport.clientWidth-76)/(model.width*(maxX-minX)),(viewport.clientHeight-76)/(model.height*(maxY-minY)));
    model.x=model.width*model.zoom*(.5-(minX+maxX)/2);model.y=model.height*model.zoom*(.5-(minY+maxY)/2);renderViewportTransform();
  }
}
function zoomViewport(factor,anchor=null){
  if(!state.roomImage)return;const viewport=$('canvasViewport'),model=state.viewport,rect=viewport.getBoundingClientRect(),x=anchor?anchor[0]-rect.left:viewport.clientWidth/2,y=anchor?anchor[1]-rect.top:viewport.clientHeight/2;
  const previous=model.zoom,next=Math.min(4,Math.max(.2,previous*factor)),left=(viewport.clientWidth-model.width*previous)/2+model.x,top=(viewport.clientHeight-model.height*previous)/2+model.y;
  model.x=x-(x-left)/previous*next-(viewport.clientWidth-model.width*next)/2;model.y=y-(y-top)/previous*next-(viewport.clientHeight-model.height*next)/2;model.zoom=next;renderViewportTransform();
}
function setupViewportEvents(){
  const viewport=$('canvasViewport');
  viewport.addEventListener('pointerdown',event=>{
    if(event.button!==0||state.loading||!state.room||!(state.spacePan||state.tool==='pan'))return;
    event.preventDefault();event.stopPropagation();state.pan={id:event.pointerId,startX:event.clientX,startY:event.clientY,x:state.viewport.x,y:state.viewport.y};viewport.setPointerCapture(event.pointerId);updateEditorChrome();
  },true);
  viewport.addEventListener('pointermove',event=>{if(state.pan?.id!==event.pointerId)return;event.preventDefault();event.stopPropagation();state.viewport.x=state.pan.x+event.clientX-state.pan.startX;state.viewport.y=state.pan.y+event.clientY-state.pan.startY;renderViewportTransform();},true);
  const finishPan=event=>{if(state.pan?.id!==event.pointerId)return;state.pan=null;state.ignoreClickUntil=performance.now()+180;if(viewport.hasPointerCapture(event.pointerId))viewport.releasePointerCapture(event.pointerId);event.preventDefault();event.stopPropagation();updateEditorChrome();};
  viewport.addEventListener('pointerup',finishPan,true);viewport.addEventListener('pointercancel',finishPan,true);
  viewport.addEventListener('lostpointercapture',()=>{state.pan=null;updateEditorChrome();});
  viewport.addEventListener('click',event=>{if(state.tool==='pan'||state.spacePan||performance.now()<state.ignoreClickUntil){event.preventDefault();event.stopPropagation();}},true);
  viewport.addEventListener('wheel',event=>{if(state.loading||!state.room)return;event.preventDefault();zoomViewport(Math.exp(-Math.max(-120,Math.min(120,event.deltaY))*.002),[event.clientX,event.clientY]);},{passive:false});
  const observer=new ResizeObserver(queueViewportLayout);observer.observe(viewport);window.addEventListener('resize',queueViewportLayout);
  window.addEventListener('blur',()=>{state.spacePan=false;state.pan=null;updateEditorChrome();});
}


function setupGeometryEvents(){
  all('.quad-handle').forEach(handle=>{
    let pointer=null;
    handle.addEventListener('pointerdown',event=>{if(state.edit?.kind!=='quad'||event.button!==0||state.spacePan)return;pointer=event.pointerId;handle.setPointerCapture(pointer);event.preventDefault();handle.focus({preventScroll:true});});
    handle.addEventListener('pointermove',event=>{if(pointer!==event.pointerId||state.edit?.kind!=='quad'||state.spacePan)return;const point=imagePoint(event,{clamp:false});if(point)state.edit.quad[Number(handle.dataset.corner)]=point;drawQuad();event.preventDefault();});
    ['pointerup','pointercancel','lostpointercapture'].forEach(type=>handle.addEventListener(type,()=>{pointer=null;}));
    handle.addEventListener('keydown',event=>{const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];if(!delta||state.edit?.kind!=='quad')return;event.preventDefault();event.stopPropagation();const index=Number(handle.dataset.corner),step=event.shiftKey ? .02 : .002;state.edit.quad[index]=state.edit.quad[index].map((value,axis)=>Math.min(3,Math.max(-2,value+delta[axis]*step)));drawQuad();});
  });
  const protection=$('protectionDrawingOverlay');let protectionStart=null;
  protection.addEventListener('pointerdown',event=>{if(state.edit?.kind!=='protection'||event.button!==0||state.spacePan)return;protectionStart=[event.clientX,event.clientY,event.pointerId];protection.setPointerCapture(event.pointerId);event.preventDefault();});
  protection.addEventListener('pointermove',event=>{if(state.edit?.kind!=='protection'||state.spacePan)return;state.edit.hover=imagePoint(event);drawProtectionDraft();});
  protection.addEventListener('pointerup',event=>{
    if(state.edit?.kind!=='protection'||!protectionStart||protectionStart[2]!==event.pointerId||state.spacePan)return;
    const start=protectionStart;protectionStart=null;if(Math.hypot(event.clientX-start[0],event.clientY-start[1])>9)return;
    if(state.edit.points.length>=32){toast('You have 32 points. Save the protected area or undo a point.');return;}
    const point=imagePoint(event);if(point)state.edit.points.push(point);state.edit.hover=null;drawProtectionDraft();event.preventDefault();
  });
  protection.addEventListener('pointercancel',()=>{protectionStart=null;});
  protection.addEventListener('pointerleave',()=>{if(state.edit?.kind==='protection'){state.edit.hover=null;drawProtectionDraft();}});
  const overlay=$('newRegionOverlay');let start=null;
  overlay.addEventListener('pointerdown',event=>{
    const edit=state.edit;if(!edit?.kind.startsWith('new-')||event.button!==0||state.spacePan)return;
    start={id:event.pointerId,x:event.clientX,y:event.clientY,point:imagePoint(event)};if(!start.point)return;
    overlay.setPointerCapture(event.pointerId);event.preventDefault();if(edit.kind==='new-rectangle'){edit.start=start.point;edit.points=rectanglePoints(start.point,start.point);drawNewRegion();}
  });
  overlay.addEventListener('pointermove',event=>{
    const edit=state.edit;if(!edit?.kind.startsWith('new-')||state.spacePan)return;
    const point=imagePoint(event);if(!point)return;edit.hover=point;
    if(edit.kind==='new-rectangle'&&start?.id===event.pointerId)edit.points=rectanglePoints(start.point,point);drawNewRegion();
  });
  overlay.addEventListener('pointerup',event=>{
    const edit=state.edit;if(!edit?.kind.startsWith('new-')||!start||start.id!==event.pointerId||state.spacePan)return;
    const initial=start;start=null;const point=imagePoint(event);if(!point)return;edit.hover=null;
    if(edit.kind==='new-rectangle'){
      edit.points=rectanglePoints(initial.point,point);
      if(Math.abs(event.clientX-initial.x)<12||Math.abs(event.clientY-initial.y)<12||!quadValid(edit.points)){edit.points=[];drawNewRegion();toast('This region is too small. Draw a larger rectangle.');return;}
      commitNewRegion();
    }else{
      if(Math.hypot(event.clientX-initial.x,event.clientY-initial.y)>9)return;
      if(edit.points.length>=4){toast('Undo a point to adjust, or press Esc to cancel.');return;}
      edit.points.push(point);drawNewRegion();if(edit.points.length===4)commitNewRegion();
    }
    event.preventDefault();
  });
  overlay.addEventListener('pointercancel',()=>{start=null;if(state.edit?.kind==='new-rectangle'){state.edit.points=[];drawNewRegion();}});
  overlay.addEventListener('pointerleave',()=>{if(state.edit?.kind==='new-quad'){state.edit.hover=null;drawNewRegion();}});
}
function updateWaitingVisual(){const demo=state.motionDemo,job=state.job,candidate=demo||(job&&['submitting','queued','running'].includes(job.status)?job:null),show=candidate&&candidate.key===currentKey()&&!state.edit&&['ai','compare'].includes(state.mode);$('aiPanel').setAttribute('aria-busy',String(Boolean(show&&!demo)));if(!show){waitingMotion.hide({reveal:Boolean(matchingAI()&&!demo&&(!job||job.status==='done'))});return;}const receiving=!demo&&/received|saving|complete/.test(String(job?.phase||''));waitingMotion.show({token:candidate.token,roomSrc:candidate.roomSrc,surfaces:candidate.snapshot.surfaces.map(surface=>({...surface,_customLabel:Boolean((candidate.editableSurfaces||state.surfaces).find(item=>item.id===surface.id)?._customLabel)})),tiles:state.catalog.tiles,demo:Boolean(demo),label:demo?'Loading animation preview':receiving?'Your room is almost ready':job.status==='submitting'?'Submitting the whole room':'Generating the whole room',detail:demo?'Previewing the animation across all regions. No AI request is sent.':receiving?'Receiving and loading the complete result':`${uiRegionCount(candidate.snapshot.surfaces.length)} in one AI generation`,elapsedMs:performance.now()-candidate.submittedAt});}
function stopMotionPreview({quiet=false}={}){if(!state.motionDemo)return;clearInterval(state.motionDemoTimer);state.motionDemoTimer=null;state.motionDemo=null;$('previewMotion').textContent='Preview loading animation · No AI request';$('previewMotion').setAttribute('aria-pressed','false');waitingMotion.hide();if(!quiet)updateAIResult();}
function previewMotion(){if(state.motionDemo){stopMotionPreview();return;}if(!state.room||!state.surfaces.length||state.loading||state.edit||jobIsActive())return;state.motionDemo={token:`demo-${Date.now()}`,key:currentKey(),submittedAt:performance.now(),roomSrc:state.room.src,snapshot:{roomId:state.room.id,surfaces:canonicalSurfaces()}};$('previewMotion').textContent='Stop animation preview';$('previewMotion').setAttribute('aria-pressed','true');setView('ai');state.motionDemoTimer=setInterval(()=>{if(state.motionDemo)waitingMotion.tick(performance.now()-state.motionDemo.submittedAt,true);},500);}
async function uploadRoom(file){if(!file)return;if(!['image/jpeg','image/png','image/webp'].includes(file.type)){toast('Choose a JPG, PNG or WebP image.',true);return;}if(file.size>20*1024*1024){toast('This photo is over 20 MB. Reduce its size and try again.',true);return;}const started=performance.now();setSceneBusy(true,'Reading your photo locally…');try{const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('The photo could not be read. Please select it again.'));reader.readAsDataURL(file);});const image=await loadImage(dataUrl);let src=dataUrl,width=image.naturalWidth,height=image.naturalHeight;const ratio=Math.min(1,2048/Math.max(width,height)),resized=ratio<1;if(resized||file.size>5*1024*1024){const buffer=document.createElement('canvas');width=Math.round(width*ratio);height=Math.round(height*ratio);buffer.width=width;buffer.height=height;const context=buffer.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,width,height);context.drawImage(image,0,0,width,height);src=buffer.toDataURL('image/jpeg',.92);buffer.width=buffer.height=0;}const room={id:`upload-${Date.now()}`,name:file.name.replace(/\.[^.]+$/,'').slice(0,34)||'My room',src,width,height,synthetic:false,uploaded:true,sourceNote:resized?'Resized locally to a maximum edge of 2,048 px. Draw each region you want to tile.':'Your local photo. Draw the regions you want to tile.',surfaces:[]};state.customRoom=room;renderRoomOptions();setSceneBusy(false);await selectRoom(room);metrics.uploads.push({at:performance.now(),durationMs:performance.now()-started,originalBytes:file.size,width,height,resized});}catch(error){setSceneBusy(false);toast(readableError(error),true);}finally{$('roomUpload').value='';}}
async function checkHealth(){
  $('refreshConnection').disabled=true;
  try{const health=await jsonRequest('/api/health',{signal:AbortSignal.timeout(8000)});state.health={...health,proxyReachable:Boolean(health.configured)};$('proxyStatus').textContent=health.configured?'API configured: '+(health.endpointOrigin||'provider')+' · Availability is checked when you generate.':'AI is optional. Configure TILE_API_KEY and TILE_API_MODEL in the local .env file, then restart the server. No request has been sent.';}
  catch{state.health={configured:false,proxyReachable:false};$('proxyStatus').textContent='Cannot reach the local server. Restart it and check configuration.';}
  finally{$('refreshConnection').disabled=false;updateDisabledState();}
}
const JOB_STATUSES=['queued','running','done','failed','cancelled'];
const MAX_STATUS_WINDOW_MS=8*60*1000;
const remainingRetry=job=>Math.max(0,(job?.retryAt||0)-Date.now());
const mayRetryGeneration=job=>Boolean(job&&['failed','cancelled'].includes(job.status)&&job.recovery?.executionState!=='uncertain'&&(job.recovery?.action==='retry_generation'||(job.recovery?.action==='wait'&&job.recovery.executionState==='not_started')));

function jobDescription(job){
  if(job.startNewConfirmed)return'The earlier request could not be confirmed and may still be running. Start new request anyway submits the same design as a separate attempt and may duplicate generation.';
  if(job.checking)return'Checking the original request. No new generation is being submitted.';
  if(job.cancelUnconfirmed)return'Cancellation is not confirmed. The original request may still be running. Check its status before deciding what to do next.';
  if(job.status==='submitting')return`Submitting the photo, ${uiRegionCount(job.snapshot.surfaces.length)} and their tile references.`;
  if(job.status==='queued')return'The complete submitted design is queued on the local server.';
  if(job.status==='cancelling')return'Cancellation requested. Waiting for the service to confirm its status; upstream work may already have started.';
  if(job.status==='reconnecting')return'Connection interrupted. Checking the original request with a limited number of retries. No new generation has been sent.';
  if(job.status==='status_paused')return'Automatic status checks are paused. The earlier request may still be running. Check status to reconnect; your submitted design is retained.';
  if(job.status==='result_loading')return'The AI output is already saved by the service. Loading that same image; no new generation is being requested.';
  if(job.status==='result_failed')return'The saved AI output could not load after three attempts. Reload result fetches the same image and does not generate it again.';
  if(job.status==='cancelled')return'The service confirmed cancellation. Upstream work may already have started; your photo and regions remain available.';
  if(job.status==='failed'){
    const message=uiErrorMessage(job.error,'The AI request did not finish.');
    if(job.recovery?.executionState==='uncertain')return`${message} The earlier outcome is unconfirmed. Check status before choosing a separate new request.`;
    if(job.recovery?.action==='change_input')return`${message} Edit the design or choose another photo before generating again.`;
    if(job.recovery?.action==='unavailable')return`${message} Check the local service or account access. You can keep editing or use the non-AI tile preview.`;
    if(remainingRetry(job)>0)return`${message} Wait ${Math.ceil(remainingRetry(job)/1000)} seconds before trying the submitted design again.`;
    return`${message} You can retry the submitted design as a new attempt or keep editing.`;
  }
  if(job.status==='done')return`${job.key===currentKey()?'The AI result for this design is ready.':'The image is ready for the submitted design. Restore that design to view its matching result.'}${job.warning?` ${uiErrorMessage(job.warning,'The original image is available.')}`:''}`;
  if(/download|saving|persist/.test(String(job.phase||'')))return'Receiving and saving the complete room image.';
  return'Waiting for the model to return the whole room. The timer shows actual elapsed time.';
}
function updateJobElapsed(){
  const job=state.job;if(!job)return;
  $('jobElapsed').textContent=jobIsActive()?`Elapsed ${duration(performance.now()-job.submittedAt)}`:finite(job.elapsedMs)?duration(job.elapsedMs):'';
  if(!state.motionDemo&&jobIsActive())waitingMotion.tick(performance.now()-job.submittedAt);
  if(remainingRetry(job)>0||job.retryAt){updateJobActions();if(job.retryAt&&remainingRetry(job)===0&&!jobIsActive()){clearInterval(state.jobTimer);state.jobTimer=null;updateAIResult();}}
}
function updateJobActions(){
  const job=state.job;if(!job)return;
  const busy=Boolean(job.checking||job.resultLoading||job.actionBusy||job.status==='submitting'),uncertain=jobIsUncertain(job),mismatch=job.key!==currentKey();
  $('jobDetail').textContent=jobDescription(job);
  $('jobDesignNote').textContent=mismatch?'The canvas has changed. Retry uses the submitted photo and regions. Generate current design uses your newer edits.':'';
  $('jobDesignNote').hidden=!mismatch;
  const stored=job.storageStatus==='saved';
  $('jobStorage').textContent=stored?'Submitted design saved in this browser. Expires after 24 hours and is cleared on the next opening.':job.storageStatus==='saving'?'Saving the submitted design in this browser…':job.persistenceDisabled?'Saved browser copy discarded. This tab still retains the submitted design.':'Kept in this tab only. Browser storage is unavailable; refreshing may lose this design.';
  $('jobRetry').hidden=!mayRetryGeneration(job);$('jobRetry').disabled=busy||remainingRetry(job)>0;
  $('jobRetry').textContent=`Retry ${stored?'saved':'submitted'} design (new attempt)`;
  $('jobCheckStatus').hidden=!uncertain&&!['failed','cancelled'].includes(job.status)&&!(job.status==='result_failed'&&!job.resultUrl);$('jobCheckStatus').disabled=busy;
  $('jobReconnect').hidden=Boolean(job.id)||!uncertain;$('jobReconnect').disabled=busy;
  $('jobReloadResult').hidden=!['result_failed','done'].includes(job.status)||!job.resultUrl;$('jobReloadResult').disabled=busy;
  $('jobUsePreview').hidden=!['failed','cancelled','status_paused','reconnecting','result_failed'].includes(job.status);$('jobUsePreview').disabled=state.loading||!state.surfaces.length||pendingCalibration()||Boolean(state.edit);
  $('jobEditDesign').hidden=!['failed','cancelled','status_paused','reconnecting','result_failed'].includes(job.status);$('jobEditDesign').disabled=state.loading;
  $('jobRestoreDesign').hidden=!mismatch;$('jobRestoreDesign').disabled=state.loading||Boolean(state.edit)||busy;
  $('jobDiscardSaved').hidden=job.persistenceDisabled;$('jobDiscardSaved').disabled=job.discarding;
  $('jobStartNew').hidden=!uncertain||job.status==='reconnecting';$('jobStartNew').disabled=busy;
  $('jobStartNew').textContent=job.startNewConfirmed?'Start new request anyway':'Start a new request';
  $('cancelJob').hidden=!['queued','running','cancelling','reconnecting','status_paused'].includes(job.status)||job.serverStatus==='failed';
  $('cancelJob').disabled=job.status==='cancelling'||Boolean(job.cancelling)||busy;
  if(jobBlocksGeneration())$('generateButton').textContent=jobIsActive()?'Generating…':remainingRetry(job)>0?'Wait before retrying':'Resolve previous request';
  else if(mismatch)$('generateButton').textContent='Generate current design';
}
function updateJobPanel(){
  const job=state.job;$('jobPanel').hidden=!job;if(!job)return;
  const labels={submitting:'Preparing request',queued:'Queued',running:'Generating',cancelling:'Cancellation requested',reconnecting:'Reconnecting',status_paused:'Status checks paused',result_loading:'Loading saved result',result_failed:'Result download paused',done:'Complete',failed:'AI request failed',cancelled:'Cancellation confirmed'};
  $('jobStatus').textContent=labels[job.status]||'Request status';$('jobPanel').dataset.state=job.status;
  updateJobElapsed();updateAIResult();updateJobActions();
}
function stopJobTimers(){clearInterval(state.jobTimer);clearTimeout(state.pollTimer);state.jobTimer=null;state.pollTimer=null;}
function startJobClock(job){clearInterval(state.jobTimer);if(state.job===job&&(jobIsActive()||remainingRetry(job)>0))state.jobTimer=setInterval(updateJobElapsed,500);}
function minimalRoom(room){return{id:room.id,name:room.name,src:room.src,width:room.width,height:room.height,uploaded:Boolean(room.uploaded),synthetic:Boolean(room.synthetic),sourceNote:room.sourceNote};}
function storedJob(job){
  const fields=['id','status','serverStatus','phase','elapsedMs','model','error','errorCode','recovery','resultUrl','originalResultUrl','guideUrl','warning','warningCode','retryAt','cancelUnconfirmed'];
  const metadata={};for(const field of fields)if(job[field]!==undefined)metadata[field]=job[field];
  return{version:1,createdAt:job.createdAt,expiresAt:job.createdAt+RECOVERY_TTL_MS,clientRequestId:job.clientRequestId,snapshot:structuredClone(job.snapshot),room:{...job.room},editableSurfaces:cloneEditable(job.editableSurfaces),activeId:job.activeId,job:metadata};
}
async function persistJob(job){
  if(job.persistenceDisabled)return false;
  const record=storedJob(job);job.storageStatus='saving';if(state.job===job)updateJobActions();
  try{await submissionStore.save(record);if(job.persistenceDisabled)return false;job.storageStatus='saved';if(state.job===job)updateJobActions();return true;}
  catch{if(!job.persistenceDisabled){job.storageStatus='unavailable';if(state.job===job)updateJobActions();}return false;}
}
async function loadSavedSubmission(){
  try{state.recoveryCandidate=await submissionStore.load();if(state.recoveryCandidate)showRecoveryPrompt();}
  catch{toast('Browser recovery storage is unavailable. Submitted designs can only be kept in this tab.',true);}
  finally{state.recoveryLoaded=true;updateDisabledState();}
}
function showRecoveryPrompt({confirm=false,fromJob=false}={}){
  $('recoveryPrompt').hidden=false;$('recoveryPrompt').dataset.fromJob=String(fromJob);
  $('recoveryTitle').textContent=confirm?'Replace the current design?':'A submitted design is available';
  $('recoveryDetail').textContent=confirm?'Restoring replaces the photo and regions currently on the canvas. Choose Replace current design to continue.':'Restore the submitted photo, regions and request status, or discard its browser copy. Stored for up to 24 hours; expired copies are cleared on the next opening.';
  $('restoreSavedDesign').textContent=confirm?'Replace current design':'Restore saved design';
  $('discardSavedDesign').textContent=fromJob?'Keep current design':'Discard saved design';
}
function jobFromRecord(record){
  const snapshot=freezeSnapshot(record.snapshot),job={...record.job,token:`job-${requestId()}`,clientRequestId:record.clientRequestId,createdAt:record.createdAt,submittedAt:performance.now()-(Date.now()-record.createdAt),snapshot,key:fingerprint(snapshot.roomId,snapshot.surfaces),room:{...record.room},roomName:record.room.name,roomSrc:record.room.src,editableSurfaces:cloneEditable(record.editableSurfaces||snapshot.surfaces),activeId:record.activeId,storageStatus:'saved',pollFailures:0};
  if(['submitting','queued','running','cancelling','reconnecting'].includes(job.status)){job.status='status_paused';job.recovery=safeRecovery(job.recovery,{executionState:'uncertain'});}
  if(job.status==='result_loading')job.status='result_failed';
  return job;
}
async function restoreSubmittedDesign(fromJob=false){
  const record=fromJob&&state.job?storedJob(state.job):state.recoveryCandidate;
  if(!record||state.loading||state.edit)return;
  const savedKey=fingerprint(record.snapshot.roomId,record.snapshot.surfaces),confirmation=`${record.clientRequestId}|${currentKey()}`;
  if(savedKey!==currentKey()&&state.recoveryRestoreKey!==confirmation){state.recoveryRestoreKey=confirmation;showRecoveryPrompt({confirm:true,fromJob});return;}
  $('restoreSavedDesign').disabled=true;setSceneBusy(true,'Restoring the submitted photo and regions…');
  try{
    stopMotionPreview({quiet:true});saveDraft();if(state.renderTask)await state.renderTask;
    const room={...record.room},image=await loadImage(room.src),surfaces=cloneEditable(record.editableSurfaces||record.snapshot.surfaces);
    await ensureTiles(surfaces);await state.renderer.setScene({image});
    state.room=room;state.roomImage=image;state.surfaces=surfaces;state.activeId=surfaces.some(surface=>surface.id===record.activeId)?record.activeId:surfaces[0]?.id;state.activeCaseId=null;
    if(room.uploaded)state.customRoom=room;
    state.lastRender=null;$('tileCanvas').hidden=true;state.tool='select';state.viewport.zoom=1;state.viewport.x=state.viewport.y=0;
    if(!fromJob){stopJobTimers();state.job=jobFromRecord(record);}
    state.recoveryCandidate=null;state.recoveryRestoreKey=null;$('recoveryPrompt').hidden=true;
    seedHistory();saveDraft();renderRoomOptions();updateRoomDetails();updateCaseDetails();renderSurfaceOptions();renderAssignments();updateCurrentControls();drawSurfaceMap();setSceneBusy(false);setView('original');fitViewport();
    await renderNow('restore-submitted-design');updateJobPanel();
    // Restoring only reads the existing request/output. It never submits generation.
    if(state.job){state.job.checkUntil=Date.now()+MAX_STATUS_WINDOW_MS;await pollJob(state.job,{manual:true});}
  }catch(error){setSceneBusy(false);toast(`The submitted design could not be restored. ${readableError(error)}`,true);}
  finally{$('restoreSavedDesign').disabled=false;}
}
async function discardSavedSubmission(){
  if($('recoveryPrompt').dataset.fromJob==='true'){state.recoveryRestoreKey=null;$('recoveryPrompt').hidden=true;return;}
  $('discardSavedDesign').disabled=true;
  try{await submissionStore.clear();state.recoveryCandidate=null;state.recoveryRestoreKey=null;$('recoveryPrompt').hidden=true;toast('The saved browser copy was discarded.');}
  catch{toast('The saved copy could not be removed from browser storage. Please try again.',true);}
  finally{$('discardSavedDesign').disabled=false;updateDisabledState();}
}
async function clearJobSavedCopy(){
  const job=state.job;if(!job||job.discarding)return;job.discarding=true;job.persistenceDisabled=true;updateJobActions();
  try{await submissionStore.clear();job.storageStatus='discarded';toast('The saved browser copy was discarded. The design remains in this tab.');}
  catch{job.persistenceDisabled=false;job.storageStatus='unavailable';toast('The saved copy could not be removed. Please try again.',true);}
  finally{job.discarding=false;updateJobActions();}
}
function newAttempt(source=null){
  const snapshot=source?source.snapshot:{roomId:state.room.id,surfaces:canonicalSurfaces(),...(state.room.uploaded?{roomDataUrl:state.room.src}:{})};
  const room=source?source.room:minimalRoom(state.room),createdAt=Date.now();
  return{token:`job-${requestId()}`,clientRequestId:requestId(),createdAt,submittedAt:performance.now(),snapshot:freezeSnapshot(snapshot),key:source?.key||currentKey(),status:'submitting',room:{...room},roomName:room.name,roomSrc:room.src,editableSurfaces:cloneEditable(source?.editableSurfaces||state.surfaces),activeId:source?.activeId||state.activeId,pollFailures:0,checkUntil:createdAt+MAX_STATUS_WINDOW_MS,storageStatus:'saving'};
}
async function generateAI(){
  if(jobBlocksGeneration()||state.recoveryCandidate||!state.recoveryLoaded||state.loading||state.edit||pendingCalibration()||!state.room||!state.surfaces.length)return;
  await beginAttempt(newAttempt());
}
async function beginAttempt(job){
  if(!state.health?.configured){toast('Configure your API on the local server first. Open Choose room > AI connection for details.',true);return;}
  const destination=state.health.endpointOrigin||'your configured API provider';
  if(!window.confirm('Send this room image, region guide and selected tile textures to '+destination+' for AI generation? Your provider may charge your API account. Images and results will also be saved on this computer for recovery. Only continue if you have permission to share these images.'))return;
  stopMotionPreview({quiet:true});stopJobTimers();state.job=job;state.recoveryRestoreKey=null;$('recoveryPrompt').hidden=true;
  startJobClock(job);if(job.key===currentKey())setView('ai');updateJobPanel();
  await persistJob(job);if(state.job!==job)return;await submitAttempt(job);
}
function failSubmission(job,error){
  job.status='failed';job.serverStatus='failed';job.error=readableError(error);job.errorCode=error.errorCode;job.recovery=safeRecovery(error.recovery);job.elapsedMs=performance.now()-job.submittedAt;
  job.retryAt=job.recovery.retryAfterMs?Date.now()+job.recovery.retryAfterMs:null;stopJobTimers();startJobClock(job);void persistJob(job);updateJobPanel();
}
async function submitAttempt(job){
  if(state.job!==job)return;
  job.status='submitting';job.startNewConfirmed=false;updateJobPanel();startJobClock(job);
  try{
    const response=await jsonRequest('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...job.snapshot,clientRequestId:job.clientRequestId}),signal:AbortSignal.timeout(20000)});
    if(state.job!==job)return;
    if(!response.jobId&&!response.id)throw new Error('The submission receipt did not contain a job ID.');
    job.id=response.jobId||response.id;
    if(JOB_STATUSES.includes(response.status))await acceptJobUpdate(job,response);
    else{job.status='queued';job.serverStatus='queued';await persistJob(job);updateJobPanel();await pollJob(job);}
  }catch(error){
    if(state.job!==job)return;
    if(error.recovery?.executionState==='not_started'){failSubmission(job,error);return;}
    job.status='reconnecting';job.error=readableError(error);job.recovery=safeRecovery(error.recovery);job.pollFailures=0;job.receiptRecovery=true;
    stopJobTimers();void persistJob(job);updateJobPanel();await pollJob(job);
  }
}
async function readOriginalJob(job){
  const url=job.id?`/api/jobs/${encodeURIComponent(job.id)}`:`/api/requests/${encodeURIComponent(job.clientRequestId)}`;
  const update=await jsonRequest(url,{signal:AbortSignal.timeout(12000)});
  if(!JOB_STATUSES.includes(update.status)||!(update.id||update.jobId||job.id))throw new Error('The service returned an unrecognised job status.');
  return update;
}
function pauseStatus(job,error=null){
  stopJobTimers();job.status='status_paused';job.recovery=safeRecovery(error?.recovery,{executionState:'uncertain'});job.error=error?readableError(error):job.error;job.checking=false;
  void persistJob(job);updateJobPanel();
}
function scheduleStatus(job,delay=1600){
  if(state.job!==job)return;
  if(Date.now()+delay>job.checkUntil){pauseStatus(job);return;}
  clearTimeout(state.pollTimer);state.pollTimer=setTimeout(()=>void pollJob(job),delay);
}
async function acceptJobUpdate(job,update,{schedule=true}={}){
  if(state.job!==job)return;
  const before=JSON.stringify([job.serverStatus,job.phase,job.errorCode,job.resultUrl]);
  job.id=update.id||update.jobId||job.id;job.serverStatus=update.status;job.status=job.cancelling&&['queued','running'].includes(update.status)?'cancelling':update.status;
  for(const field of ['phase','elapsedMs','model','error','errorCode','resultUrl','originalResultUrl','guideUrl','warning','warningCode'])if(update[field]!==undefined)job[field]=update[field];
  job.recovery=update.recovery?safeRecovery(update.recovery):null;job.pollFailures=0;job.receiptRecovery=false;job.checking=false;job.startNewConfirmed=false;
  if(!job.retryAt&&job.recovery?.retryAfterMs)job.retryAt=Date.now()+job.recovery.retryAfterMs;
  if(['done','failed','cancelled'].includes(update.status))job.cancelUnconfirmed=false;
  if(update.status==='done'){
    stopJobTimers();await persistJob(job);
    if(!job.resultUrl){job.status='result_failed';job.error='The completed job has no saved image URL. Check status to retrieve it.';updateJobPanel();return;}
    await loadJobResult(job);return;
  }
  if(['failed','cancelled'].includes(update.status)){stopJobTimers();startJobClock(job);await persistJob(job);updateJobPanel();return;}
  if(before!==JSON.stringify([job.serverStatus,job.phase,job.errorCode,job.resultUrl]))void persistJob(job);
  startJobClock(job);updateJobPanel();if(schedule)scheduleStatus(job);
}
async function pollJob(job,{manual=false}={}){
  if(state.job!==job||job.checking||job.resultLoading)return;
  if(manual){job.pollFailures=0;job.checkUntil=Date.now()+MAX_STATUS_WINDOW_MS;job.startNewConfirmed=false;}
  if(!job.checkUntil)job.checkUntil=Date.now()+MAX_STATUS_WINDOW_MS;
  clearTimeout(state.pollTimer);job.checking=true;updateJobPanel();
  try{const update=await readOriginalJob(job);if(state.job!==job)return;await acceptJobUpdate(job,update);}
  catch(error){
    if(state.job!==job)return;
    job.checking=false;job.pollFailures=(job.pollFailures||0)+1;job.lastNotFound=error.status===404;job.recovery=safeRecovery(error.recovery);job.error=readableError(error);
    const maximum=job.receiptRecovery?3:4,delay=retryDelay(job.pollFailures-1,error.recovery?.retryAfterMs);
    if(job.pollFailures>=maximum||Date.now()+delay>job.checkUntil){pauseStatus(job,error);return;}
    job.status='reconnecting';clearInterval(state.jobTimer);state.jobTimer=null;updateJobPanel();scheduleStatus(job,delay);
  }finally{if(state.job===job){job.checking=false;updateJobPanel();}}
}
async function reconnectOriginalRequest(){
  const job=state.job;if(!job||job.id||job.checking||job.actionBusy||job.status==='submitting')return;
  clearTimeout(state.pollTimer);job.checking=true;job.actionBusy=true;updateJobPanel();
  try{const update=await readOriginalJob(job);await acceptJobUpdate(job,update);}
  catch(error){
    if(state.job!==job)return;
    if(error.status===404){job.checking=false;job.checkUntil=Date.now()+MAX_STATUS_WINDOW_MS;await submitAttempt(job);}
    else pauseStatus(job,error);
  }finally{job.actionBusy=false;if(state.job===job){job.checking=false;updateJobPanel();}}
}
async function retrySavedDesign(){
  const job=state.job;if(!mayRetryGeneration(job)||job.checking||job.actionBusy||remainingRetry(job)>0)return;
  clearTimeout(state.pollTimer);job.checking=true;job.actionBusy=true;updateJobPanel();
  try{
    try{const update=await readOriginalJob(job);await acceptJobUpdate(job,update,{schedule:false});}
    catch(error){if(!(error.status===404&&!job.id&&job.recovery?.executionState==='not_started'))throw error;}
    if(state.job!==job)return;
    if(['queued','running','cancelling'].includes(job.status)){job.checkUntil=Date.now()+MAX_STATUS_WINDOW_MS;scheduleStatus(job);return;}
    if(!mayRetryGeneration(job)||remainingRetry(job)>0)return;
    await beginAttempt(newAttempt(job));
  }catch(error){if(state.job===job)pauseStatus(job,error);}
  finally{job.actionBusy=false;if(state.job===job){job.checking=false;updateJobPanel();}}
}
async function startSeparateRequest(){
  const job=state.job;if(!jobIsUncertain(job)||job.checking||job.actionBusy)return;
  if(job.startNewConfirmed){await beginAttempt(newAttempt(job));return;}
  clearTimeout(state.pollTimer);job.checking=true;job.actionBusy=true;updateJobPanel();
  try{
    const update=await readOriginalJob(job);await acceptJobUpdate(job,update,{schedule:false});
    if(['queued','running','cancelling'].includes(job.status)){job.checkUntil=Date.now()+MAX_STATUS_WINDOW_MS;scheduleStatus(job);return;}
    if(!jobIsUncertain(job))return;
  }catch(error){if(state.job===job)pauseStatus(job,error);}
  finally{job.actionBusy=false;if(state.job===job){job.checking=false;if(jobIsUncertain(job))job.startNewConfirmed=true;updateJobPanel();}}
}
async function fetchSavedImage(url){
  const response=await fetch(url,{method:'GET',cache:'no-store',signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw new Error('The saved image is temporarily unavailable.');
  const blob=await response.blob(),displayUrl=URL.createObjectURL(blob);
  let timer;
  try{await Promise.race([loadImage(displayUrl),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('The saved image could not be decoded.')),12000);})]);return displayUrl;}
  catch(error){URL.revokeObjectURL(displayUrl);throw error;}
  finally{clearTimeout(timer);}
}
async function loadJobResult(job){
  if(state.job!==job||job.resultLoading||!job.resultUrl)return;
  const already=state.aiCache.get(job.key);if(already?.id===job.id&&already.displayUrl&&!job.forceReload){job.status='done';updateJobPanel();return;}
  job.forceReload=false;job.resultLoading=true;job.status='result_loading';stopJobTimers();updateJobPanel();
  try{
    let displayUrl,lastError;
    for(let attempt=0;attempt<3;attempt++){
      if(state.job!==job)return;
      try{displayUrl=await fetchSavedImage(job.resultUrl);break;}catch(error){lastError=error;if(attempt<2)await new Promise(resolve=>setTimeout(resolve,[600,1500][attempt]));}
    }
    if(!displayUrl)throw lastError;if(state.job!==job){URL.revokeObjectURL(displayUrl);return;}
    const result={id:job.id,url:job.resultUrl,displayUrl,originalResultUrl:job.originalResultUrl,guideUrl:job.guideUrl,key:job.key,elapsedMs:job.elapsedMs,model:job.model,kind:'generated',roomName:job.roomName,roomId:job.snapshot.roomId,surfaces:canonicalSurfaces(job.snapshot.surfaces)};
    if(already?.displayUrl)URL.revokeObjectURL(already.displayUrl);state.aiCache.set(job.key,result);state.lastAI=result;job.status='done';job.error=null;
    await persistJob(job);updateJobPanel();if(job.key===currentKey()&&!state.edit)setView('ai');
    toast(job.key===currentKey()?'Your room image is ready. Check the tiles and protected areas in every region.':'The submitted design has a result. Restore that design to view it.');
  }catch(error){if(state.job===job){job.status='result_failed';job.error=readableError(error);await persistJob(job);updateJobPanel();}}
  finally{job.resultLoading=false;if(state.job===job)updateJobPanel();}
}
async function reloadJobResult(){const job=state.job;if(!job||job.resultLoading)return;job.forceReload=true;await loadJobResult(job);}
async function cancelJob(){
  const job=state.job;if(!job||job.cancelling||job.checking)return;
  clearTimeout(state.pollTimer);job.cancelling=true;job.cancelUnconfirmed=true;job.status='cancelling';updateJobPanel();
  try{
    if(!job.id){const update=await readOriginalJob(job);await acceptJobUpdate(job,update,{schedule:false});if(['done','failed','cancelled'].includes(job.serverStatus))return;}
    if(state.job!==job||!job.id)return;
    await jsonRequest(`/api/jobs/${encodeURIComponent(job.id)}/cancel`,{method:'POST',signal:AbortSignal.timeout(12000)});
    if(state.job!==job)return;job.checkUntil=Date.now()+MAX_STATUS_WINDOW_MS;await pollJob(job,{manual:true});
  }catch(error){if(state.job===job){pauseStatus(job,error);toast('Cancellation is not confirmed. Check the original request status.',true);}}
  finally{job.cancelling=false;if(state.job===job){void persistJob(job);updateJobPanel();}}
}
async function refreshSamples(){if(state.loading)return;$('refreshSamples').disabled=true;try{const catalog=await jsonRequest('/api/catalog');const count=addExamples(catalog);state.catalog.examples=catalog.examples||[];updateAIResult();toast(matchingAI()?'Loaded the saved AI sample matching this complete design.':count?'Samples refreshed. No image matches all regions in the current design.':'No saved samples yet. You can generate this complete design.');}catch(error){toast(readableError(error),true);}finally{$('refreshSamples').disabled=false;}}
function triggerDownload(url,filename){const link=document.createElement('a');link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);}
async function downloadSavedBlob(url){
  let error;
  for(let attempt=0;attempt<3;attempt++){
    try{const response=await fetch(url,{method:'GET',cache:'no-store',signal:AbortSignal.timeout(12000)});if(!response.ok)throw new Error('The saved image download is temporarily unavailable.');return await response.blob();}
    catch(failure){error=failure;if(attempt<2)await new Promise(resolve=>setTimeout(resolve,[600,1500][attempt]));}
  }
  throw new Error('The saved image download failed after three tries. Download again retries the same saved image; it does not generate another image.',{cause:error});
}
async function downloadResult(){if(!state.room||state.loading||state.edit)return;$('downloadButton').disabled=true;const filename=`tilekind-${state.room.id}-${state.surfaces.length}-surfaces`.replace(/[^a-zA-Z0-9_-]/g,'_');try{let blob,suffix;if(state.mode==='programmatic'){if(state.renderTask)await state.renderTask;await renderNow('download');blob=await new Promise(resolve=>$('tileCanvas').toBlob(resolve,'image/png'));suffix='programmatic';if(!blob)throw new Error('The browser could not export the tile preview. Please try again.');}else{const match=matchingAI(),url=state.mode==='original'?state.room.src:match?.originalResultUrl||match?.url;if(!url)throw new Error('There is no AI image for this complete design. Generate one first.');blob=await downloadSavedBlob(url);suffix=state.mode==='original'?'original':'ai';}const extension=blob.type==='image/jpeg'?'jpg':blob.type==='image/webp'?'webp':blob.type==='image/svg+xml'?'svg':'png';triggerDownload(URL.createObjectURL(blob),`${filename}-${suffix}.${extension}`);toast('Download ready.');}catch(error){toast(readableError(error),true);}finally{updateDisabledState();}}

async function resetCurrent(){
  if(state.loading||state.edit||!state.room)return;
  const testCase=(state.catalog.testCases||[]).find(item=>item.id===state.activeCaseId);
  state.surfaces=testCase?caseSurfaces(testCase):roomSurfaces(state.room);state.activeId=state.surfaces[0]?.id||null;
  surfacesChanged('scene-reset');setView('original');fitViewport();toast(testCase?'Preset restored. Use Undo to restore your changes.':'Original room regions restored. Use Undo to restore your changes.');
}
function setupEvents(){
  $('testCaseSelect').addEventListener('change',()=>{void selectTestCase($('testCaseSelect').value);});
  all('[data-view]').forEach(button=>button.addEventListener('click',()=>setView(button.dataset.view)));
  document.querySelector('.view-tabs').addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)||state.edit)return;event.preventDefault();
    const tabs=all('[data-view]').filter(button=>!button.disabled&&!button.hidden),index=tabs.findIndex(button=>button.dataset.view===state.mode),next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
    setView(tabs[next].dataset.view);tabs[next].focus();
  });
  all('input[name="layout"]').forEach(input=>input.addEventListener('change',()=>changeSettings({layout:input.value})));
  all('input[name="rotation"]').forEach(input=>input.addEventListener('change',()=>changeSettings({rotation:Number(input.value)})));
  [['scaleInput','scale'],['groutInput','groutMm'],['groutColor','groutColor']].forEach(([id,key])=>{
    const input=$(id);input.addEventListener('input',()=>changeSettings({[key]:key==='groutColor'?input.value:Number(input.value)},{mergeKey:id}));
    ['change','pointerup','blur'].forEach(type=>input.addEventListener(type,()=>{state.historyMerge=null;}));
  });
  all('[data-colour]').forEach(button=>button.addEventListener('click',()=>changeSettings({groutColor:button.dataset.colour})));
  $('surfaceName').addEventListener('input',()=>{const surface=activeSurface();if(!surface||state.edit)return;const label=$('surfaceName').value.trim().slice(0,40)||UI_KIND_NAMES[surface.kind];if(label===uiSurfaceLabel(surface))return;surface.label=label;surface._customLabel=true;surfacesChanged('surface-name',{keepName:true,mergeKey:`name:${surface.id}`});});
  $('surfaceName').addEventListener('blur',()=>{state.historyMerge=null;if(activeSurface())$('surfaceName').value=uiSurfaceLabel(activeSurface());});
  $('surfaceKind').addEventListener('change',()=>{if(!activeSurface()||state.edit)return;activeSurface().kind=$('surfaceKind').value;surfacesChanged('surface-kind');});
  $('addSurface').addEventListener('click',addSurface);$('drawRectangle').addEventListener('click',()=>beginNewRegion('new-rectangle'));
  $('selectTool').addEventListener('click',()=>chooseTool('select'));$('panTool').addEventListener('click',()=>chooseTool('pan'));
  $('deleteSurface').addEventListener('click',removeSurface);$('moveSurfaceBack').addEventListener('click',()=>moveSurface(-1));$('moveSurfaceForward').addEventListener('click',()=>moveSurface(1));
  $('calibrateButton').addEventListener('click',beginQuadEdit);$('drawProtection').addEventListener('click',beginProtection);
  $('clearProtections').addEventListener('click',()=>{const surface=activeSurface();if(!surface||state.edit)return;surface.exclusions=surface.exclusions.slice(0,surface._presetCount);surfacesChanged('protections-clear');toast('Custom protected areas cleared. Preset protection is retained.');});
  $('cancelCalibration').addEventListener('click',cancelEdit);$('applyCalibration').addEventListener('click',applyEdit);$('undoProtectionPoint').addEventListener('click',undoDraftPoint);
  $('undoAction').addEventListener('click',()=>{if(state.edit?.points?.length)undoDraftPoint();else restoreHistory(-1);});$('redoAction').addEventListener('click',()=>restoreHistory(1));
  $('zoomIn').addEventListener('click',()=>zoomViewport(1.2));$('zoomOut').addEventListener('click',()=>zoomViewport(1/1.2));$('zoomFit').addEventListener('click',fitViewport);
  $('showRooms').addEventListener('click',openRoomDrawer);$('closeRooms').addEventListener('click',()=>closeRoomDrawer({focus:true}));$('roomDrawerBackdrop')?.addEventListener('click',()=>closeRoomDrawer({focus:true}));
  $('toggleInspector').addEventListener('click',()=>setInspector($('inspectorPanel').hidden));$('closeInspector')?.addEventListener('click',()=>{setInspector(false);$('toggleInspector').focus({preventScroll:true});});
  $('quickMaterial').addEventListener('click',()=>{setInspector(true,{focus:true});requestAnimationFrame(()=>document.querySelector('.material-section')?.scrollIntoView({block:'nearest',inline:'nearest'}));});
  $('quickAdjust').addEventListener('click',beginQuadEdit);$('quickDelete').addEventListener('click',removeSurface);
  $('roomUpload').addEventListener('change',()=>{void uploadRoom($('roomUpload').files[0]);});
  $('generateButton').addEventListener('click',()=>{void generateAI();});$('cancelJob').addEventListener('click',()=>{void cancelJob();});$('refreshConnection').addEventListener('click',()=>{void checkHealth();});$('refreshSamples').addEventListener('click',()=>{void refreshSamples();});
  $('jobRetry').addEventListener('click',()=>void retrySavedDesign());$('jobCheckStatus').addEventListener('click',()=>{if(state.job)void pollJob(state.job,{manual:true});});
  $('jobReconnect').addEventListener('click',()=>void reconnectOriginalRequest());$('jobReloadResult').addEventListener('click',()=>void reloadJobResult());
  $('jobUsePreview').addEventListener('click',()=>{stopMotionPreview({quiet:true});setView('programmatic');void renderNow('failure-fallback');toast('Tile preview uses a non-AI texture overlay.');});
  $('jobEditDesign').addEventListener('click',()=>{stopMotionPreview({quiet:true});setView('original');if(activeSurface())setInspector(true);});
  $('jobRestoreDesign').addEventListener('click',()=>void restoreSubmittedDesign(true));$('jobDiscardSaved').addEventListener('click',()=>void clearJobSavedCopy());
  $('jobStartNew').addEventListener('click',()=>void startSeparateRequest());
  $('restoreSavedDesign').addEventListener('click',()=>void restoreSubmittedDesign($('recoveryPrompt').dataset.fromJob==='true'));
  $('discardSavedDesign').addEventListener('click',()=>void discardSavedSubmission());
  $('downloadButton').addEventListener('click',()=>{void downloadResult();});$('resetButton').addEventListener('click',()=>{void resetCurrent();});$('previewMotion').addEventListener('click',previewMotion);
  $('aiImage').addEventListener('error',()=>{
    const match=matchingAI();if(!match)return;state.aiCache.delete(match.key);
    if(state.job?.id===match.id&&match.kind==='generated'){
      state.job.status='result_failed';state.job.error='The saved image could not be displayed.';void persistJob(state.job);updateJobPanel();
      toast('The saved result could not display. Reload result retries that same image.',true);
    }else{updateAIResult();toast('The saved AI sample could not load. Refresh saved samples to retry its image.',true);}
  });
  document.addEventListener('keydown',event=>{
    const field=event.target instanceof Element&&event.target.closest('input,textarea,select,[contenteditable="true"]');if(field)return;
    if(event.key==='Escape'){
      event.preventDefault();state.spacePan=false;state.pan=null;
      if(state.edit)cancelEdit();else if(!$('roomDrawer').hidden)closeRoomDrawer({focus:true});else if(state.tool!=='select')chooseTool('select');updateEditorChrome();return;
    }
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){
      event.preventDefault();if(event.shiftKey)restoreHistory(1);else if(state.edit?.points?.length)undoDraftPoint();else restoreHistory(-1);return;
    }
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='y'){event.preventDefault();restoreHistory(1);return;}
    if(event.ctrlKey||event.metaKey||event.altKey)return;
    if(event.code==='Space'){
      // Keep native Space activation for focused controls; temporary pan belongs to the canvas.
      if(event.target instanceof Element&&event.target.closest('button,a[href],summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[role="slider"]'))return;
      event.preventDefault();state.spacePan=true;updateEditorChrome();return;
    }
    if(event.key==='Enter'&&state.edit&&!event.target.closest('#applyCalibration,#cancelCalibration,#undoProtectionPoint')){event.preventDefault();applyEdit();return;}
    if((event.key==='Delete'||event.key==='Backspace')&&!state.edit){event.preventDefault();removeSurface();return;}
    if(event.repeat)return;const tool={v:'select',p:'quad',r:'rectangle',h:'pan'}[event.key.toLowerCase()];if(tool){event.preventDefault();chooseTool(tool);return;}
    if(event.key==='+'||event.key==='='){event.preventDefault();zoomViewport(1.2);}else if(event.key==='-'){event.preventDefault();zoomViewport(1/1.2);}else if(event.key==='0'){event.preventDefault();fitViewport();}
  });
  document.addEventListener('keyup',event=>{if(event.code==='Space'){state.spacePan=false;updateEditorChrome();}});
  setupGeometryEvents();setupViewportEvents();setInspector(!$('inspectorPanel').hidden);
  window.addEventListener('pagehide',event=>{if(event.persisted)return;stopJobTimers();clearInterval(state.motionDemoTimer);waitingMotion.destroy();cancelAnimationFrame(renderFrame);cancelAnimationFrame(state.viewportFrame);state.renderer?.destroy();});
}
async function initialise(){setupEvents();const healthPromise=checkHealth();try{state.renderer=new MultiSurfaceRenderer($('tileCanvas'));const catalog=await jsonRequest('/api/catalog');if(!catalog.rooms?.length||!catalog.tiles?.length)throw new Error('No rooms or tile textures are available. Check the local asset folder.');state.catalog=catalog;addExamples(catalog);renderCaseOptions();renderRoomOptions();renderTileOptions();const requestedCase=new URL(location.href).searchParams.get('case'),initialCase=(catalog.testCases||[]).find(item=>item.id===requestedCase);if(initialCase)await selectTestCase(initialCase.id);else{await selectRoom(catalog.rooms[0]);if(requestedCase)toast('This preset is unavailable. Showing the default room.');}await loadSavedSubmission();}catch(error){metrics.errors.push({at:performance.now(),context:'initialise',message:readableError(error)});setSceneBusy(false);globalMessage(`The room editor could not start: ${readableError(error)}`);}await healthPromise;}
void initialise();
