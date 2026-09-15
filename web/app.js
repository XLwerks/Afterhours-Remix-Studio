'use strict';
const $ = id => document.getElementById(id);
const state = { token:'', tracks:[], jobs:[], trackId:null, jobId:null, pending:null, rendered:null,
  libraryKey:'', versionsKey:'', trackKey:'', uploading:false, submitting:false, connected:false };
const sourceAudio=$('source-audio'), remixAudio=new AfterhoursBeatPlayer();
const defaults={style:'broken',change:75,drums:55,melody:60,breakdown:'roomy',length:'standard',bpm:''};
const time = seconds => {if(!Number.isFinite(seconds)) return '—';return Math.floor(seconds/60)+':'+String(Math.floor(seconds%60)).padStart(2,'0');};
const date = seconds => new Date(seconds*1000).toLocaleDateString(undefined,{day:'numeric',month:'short'});
const track = () => state.tracks.find(t=>t.id===state.trackId);
const job = () => state.jobs.find(j=>j.id===state.jobId);
function element(tag,cls,text){const e=document.createElement(tag); if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
function error(message){$('error').textContent=message||'';$('error').hidden=!message;}
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,3500);}
async function api(path,body){const response=await fetch(path,{method:body===undefined?'GET':'POST',
  headers:body===undefined?{}:{'Content-Type':'application/json','X-Studio-Token':state.token},
  body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json();if(!response.ok)throw Error(data.error||'The request could not be completed.');return data;}
function settings(){const value={};for(const key of ['change','drums','melody'])value[key]=Number($(key).value);
  for(const key of ['breakdown','length'])value[key]=$(key).value;
  value.style=document.querySelector('input[name="style"]:checked').value;value.bpm=$('bpm').value||null;return value;}
function applySettings(value){const v={...defaults,...value};for(const key of ['change','drums','melody','breakdown','length','bpm'])$(key).value=v[key]??'';
  const radio=[...document.querySelectorAll('input[name="style"]')].find(e=>e.value===v.style);if(radio)radio.checked=true;sliderLabels();}
function sliderLabels(){const descriptions={change:['Gentle','Exploring','Adventurous'],drums:['Sparse','Balanced','Busy'],melody:['Subtle','Present','Up front']};
  for(const key of ['change','drums','melody']){$(key+'-value').textContent=descriptions[key][Math.min(2,Math.floor(Number($(key).value)/34))];}}
function rememberSettings(){try{localStorage.setItem('afterhours-settings',JSON.stringify(settings()));}catch{}}
function setTrack(id){if(state.trackId===id)return;state.trackId=id;state.jobId=null;state.pending=null;state.rendered=null;state.trackKey='';state.versionsKey='';
  sourceAudio.pause();remixAudio.pause();error('');render();}
function chooseJob(id){const candidate=state.jobs.find(j=>j.id===id);if(!candidate)return;
  if(candidate.status==='error'){error(candidate.message);return;}
  if(candidate.status!=='done')return;
  state.jobId=id;state.rendered=null;remixAudio.pause();render();}
function volumeMatch(){const original=track()?.analysis?.listening_loudness??track()?.analysis?.loudness, rendered=job()?.result?.loudness;
  if($('match-volume').checked && Number.isFinite(original)&&Number.isFinite(rendered)){
    const target=Math.min(original,rendered);sourceAudio.volume=Math.min(1,10**((target-original)/20));remixAudio.volume=Math.min(1,10**((target-rendered)/20))*Number($('remix-volume').value)/100;
  }else{sourceAudio.volume=1;remixAudio.volume=Number($('remix-volume').value)/100;}}
function renderLibrary(){const key=JSON.stringify(state.tracks.map(t=>[t.id,t.name,t.status,t.analysis?.duration]))+state.trackId;
  if(key===state.libraryKey)return;state.libraryKey=key;$('track-count').textContent=state.tracks.length;$('track-list').replaceChildren();
  for(const t of state.tracks){const button=element('button','track-item'+(t.id===state.trackId?' active':''));button.setAttribute('aria-pressed',t.id===state.trackId);
    button.append(element('span','track-dot','≋'));const text=element('span');text.append(element('strong','',t.name));
    text.append(element('small','',t.status==='ready'?time(t.analysis.duration)+' · Ready':t.status==='error'?'Needs attention':'Analysing…'));button.append(text);
    button.addEventListener('click',()=>setTrack(t.id));$('track-list').append(button);}}
function drawWaveform(peaks){const svg=$('waveform');svg.replaceChildren();const namespace='http://www.w3.org/2000/svg';
  const sampled=peaks.filter((_,i)=>i%3===0);sampled.forEach((value,i)=>{const rect=document.createElementNS(namespace,'rect');const height=Math.max(3,value*99);
    rect.setAttribute('x',i*800/sampled.length);rect.setAttribute('y',(120-height)/2);rect.setAttribute('width',Math.max(2,800/sampled.length-2));rect.setAttribute('height',height);rect.setAttribute('rx','1');rect.setAttribute('class','wave-bar');svg.append(rect);});}
function updatePlayhead(){const duration=remixAudio.duration||job()?.result?.duration||1;const proportion=Math.min(1,remixAudio.currentTime/duration);
  $('waveform').setAttribute('aria-valuenow',Math.round(proportion*100));$('waveform').setAttribute('aria-valuetext',time(remixAudio.currentTime)+' of '+time(duration));
  const bars=$('waveform').children;for(let i=0;i<bars.length;i++)bars[i].classList.toggle('played',i/bars.length<proportion);renderTransport();}
function renderTransport(){
  const current=remixAudio.currentTime,queued=remixAudio.queued,selected=job();
  const play=$('remix-play');play.disabled=remixAudio.loading||(!remixAudio.ready&&!remixAudio.error);
  play.textContent=remixAudio.loading?'Loading…':remixAudio.error?'Retry':remixAudio.paused?'▶ Play':'Ⅱ Pause';
  play.setAttribute('aria-label',remixAudio.paused?'Play remix':'Pause remix');
  $('remix-time').textContent=time(current)+' / '+time(remixAudio.duration);
  $('live-beat').textContent=remixAudio.paused?'—':String(Math.floor((current+.00001)/(60/remixAudio.bpm))%4+1);
  for(const button of $('sections').children){
    const active=current>=Number(button.dataset.start)-.001&&current<Number(button.dataset.end)-.001;
    const next=!!queued&&queued.name===button.dataset.name;
    button.disabled=!remixAudio.ready;button.classList.toggle('active-section',active);button.classList.toggle('queued-section',next);
    button.setAttribute('aria-pressed',String(active&&!remixAudio.paused));
    button.setAttribute('aria-label',(next?'Queued: ':active&&!remixAudio.paused?'Playing: ':'Queue ')+button.dataset.name+(next?' — next beat':''));
  }
  let message=remixAudio.loading?'Loading audio for smooth switching…':remixAudio.error?'Could not load the remix. Press Retry.':queued?'Queued: '+queued.name+' — next beat':remixAudio.paused?'Click a section to start there. While playing, changes land on the next beat.':'Click a section to queue your next move.';
  if($('section-cue').textContent!==message)$('section-cue').textContent=message;
  $('cancel-cue').hidden=!queued;
}
function loadRemix(selected){
  // Decode the local WAV once; section jumps no longer depend on network seeks or MP3 padding.
  const url=new URL(selected.wav_url,location.href);url.searchParams.delete('download');
  remixAudio.load(url.href,selected.result.bpm,selected.result.duration).catch(exc=>toast(exc.message));
}
function renderResult(){const selected=job();$('no-result').hidden=!!selected;$('result-content').hidden=!selected;$('favorite').hidden=!selected;
  if(!selected){if(remixAudio.ready||remixAudio.loading)remixAudio.clear();return;}
  $('favorite').setAttribute('aria-pressed',!!selected.favorite);$('favorite').setAttribute('aria-label',selected.favorite?'Remove favorite':'Favorite this version');$('favorite').textContent=selected.favorite?'★':'☆';
  if(state.rendered===selected.id)return;state.rendered=selected.id;
  $('result-name').textContent=selected.name;$('approved-label').hidden=!selected.approved;
  const styles={broken:'Broken beat',techno:'Minimal techno',halftime:'Half-time'};
  $('result-meta').textContent=(selected.approved?'Your approved first remix':styles[selected.settings.style])+' · '+time(selected.result.duration)+' · '+Math.round(selected.result.bpm)+' BPM';
  $('result-duration').textContent=time(selected.result.duration);
  $('download-wav').href=selected.wav_url;$('download-mp3').href=selected.mp3_url;
  drawWaveform(selected.result.waveform||[]);$('sections').replaceChildren();
  for(const s of selected.result.sections||[]){const button=element('button','section-button');button.style.flex=String(Math.max(1,s.end-s.start));
    button.dataset.start=String(s.start);button.dataset.end=String(s.end);button.dataset.name=s.name;
    button.append(element('span','',s.name),element('small','',time(s.start)));button.title=s.name+' · '+time(s.start);button.setAttribute('aria-label','Play '+s.name+' at '+time(s.start));
    button.addEventListener('click',()=>playAt(s.start,s.name));$('sections').append(button);}loadRemix(selected);volumeMatch();renderTransport();}
function renderVersions(){const versions=state.jobs.filter(j=>j.track_id===state.trackId);
  $('version-count').textContent=versions.filter(j=>j.status==='done').length+' saved';
  const key=JSON.stringify(versions.map(j=>[j.id,j.status,j.favorite,j.message]))+state.jobId;
  if(key===state.versionsKey)return;state.versionsKey=key;$('version-list').replaceChildren();
  if(!versions.length){$('version-list').append(element('p','empty-versions','Your remixes will be saved here automatically.'));return;}
  for(const [index,j] of versions.entries()){
    const button=element('button','version-row'+(j.id===state.jobId?' selected':'')+(j.status==='error'?' error':''));
    button.setAttribute('aria-label',j.name+', '+j.status);button.append(element('span','version-number',String(versions.length-index).padStart(2,'0')));
    const detail=element('span','version-detail');detail.append(element('strong','',j.name));
    detail.append(element('small','',j.status==='done'?date(j.created)+' · '+time(j.result.duration):j.message));button.append(detail);
    button.append(element('span','version-status',j.status==='done'?(j.favorite?'★':'↗'):j.status==='error'?'Details':j.status==='queued'?'Queued':'Working'));
    button.addEventListener('click',()=>chooseJob(j.id));$('version-list').append(button);}}
function render(){if(!state.trackId || !track())state.trackId=state.tracks[0]?.id||null;
  renderLibrary();const t=track();$('empty-library').hidden=!!t;$('workspace').hidden=!t;if(!t)return;
  const key=t.id+'|'+t.status;
  if(state.trackKey!==key){state.trackKey=key;$('source-name').textContent=t.name;sourceAudio.src=t.audio_url;
    $('source-meta').textContent=t.analysis?time(t.analysis.duration)+' · Estimated '+t.analysis.bpm+' BPM'+(t.analysis.confidence==='uncertain'?' · Rhythm estimate uncertain':''):t.filename;
    $('bpm').placeholder=t.analysis?String(t.analysis.bpm):'Automatic';volumeMatch();}
  $('analysis-panel').hidden=t.status==='ready';$('analysis-text').textContent=t.message||'Analysing your track';$('retry-analysis').hidden=t.status!=='error';
  $('generate').disabled=t.status!=='ready'||state.submitting||!state.connected;
  if(state.pending){const pending=state.jobs.find(j=>j.id===state.pending);if(pending?.status==='done'){state.jobId=pending.id;state.rendered=null;state.pending=null;toast('Your new remix is ready.');}else if(pending?.status==='error'){error(pending.message);state.pending=null;}}
  if(!job()||job().track_id!==t.id)state.jobId=state.jobs.find(j=>j.track_id===t.id&&j.status==='done')?.id||null;
  const working=state.jobs.find(j=>j.track_id===t.id&&['running','queued'].includes(j.status));$('working').hidden=!working;
  if(working){$('working-title').textContent=working.status==='queued'?'Your remix is queued':'Making your remix';$('working-message').textContent=working.message;$('working-progress').value=working.progress;$('working-percent').textContent=working.progress+'%';}
  renderResult();renderVersions();}
async function refresh(){try{const data=await api('/api/state');state.tracks=data.tracks;state.jobs=data.jobs;
    if(!state.connected){state.connected=true;error('');}render();globalThis.afterhoursLive?.refresh(data);
  }catch{state.connected=false;$('generate').disabled=true;error('The studio is not connected. Open “Start Afterhours.command” on your Mac, then refresh this page.');}}
async function poll(){await refresh();setTimeout(poll,state.jobs.some(j=>['queued','running'].includes(j.status))||state.tracks.some(t=>['queued','analysing'].includes(t.status))?1500:5000);}
function upload(file){if(!file||state.uploading)return;if(file.size>200*1024*1024){error('Choose an audio file smaller than 200 MB.');return;}
  state.uploading=true;error('');$('upload-status').hidden=false;$('upload-progress').value=0;$('upload-text').textContent='Adding '+file.name;
  $('add-track').disabled=true;$('empty-upload').disabled=true;
  const xhr=new XMLHttpRequest();xhr.open('POST','/api/tracks?name='+encodeURIComponent(file.name));xhr.setRequestHeader('X-Studio-Token',state.token);xhr.setRequestHeader('Content-Type','application/octet-stream');
  xhr.upload.onprogress=e=>{if(e.lengthComputable)$('upload-progress').value=e.loaded/e.total*100;};
  const done=()=>{state.uploading=false;$('add-track').disabled=false;$('empty-upload').disabled=false;$('upload-status').hidden=true;$('file-input').value='';};
  xhr.onload=async()=>{done();let data;try{data=JSON.parse(xhr.responseText);}catch{error('The file could not be added. Please try again.');return;}
    if(xhr.status>=400){error(data.error||'The file could not be added.');return;}
    state.trackId=data.id;state.jobId=null;state.rendered=null;state.trackKey='';await refresh();toast('Track added. Finding its rhythm…');};
  xhr.onerror=()=>{done();error('The upload was interrupted. Check that the studio is running and try again.');};xhr.send(file);}
function playAt(seconds,name='Section'){if(!job())return;remixAudio.queueSection(seconds,name).catch(exc=>toast(exc.message));}
$('add-track').addEventListener('click',()=>$('file-input').click());$('empty-upload').addEventListener('click',()=>$('file-input').click());
$('file-input').addEventListener('change',e=>upload(e.target.files[0]));
for(const evt of ['dragenter','dragover'])$('drop-area').addEventListener(evt,e=>{e.preventDefault();$('drop-area').classList.add('dragging');});
for(const evt of ['dragleave','drop'])$('drop-area').addEventListener(evt,e=>{e.preventDefault();$('drop-area').classList.remove('dragging');});
$('drop-area').addEventListener('drop',e=>upload(e.dataTransfer.files[0]));
for(const key of ['change','drums','melody'])$(key).addEventListener('input',()=>{sliderLabels();rememberSettings();});
$('remix-form').addEventListener('change',rememberSettings);
$('reset-recipe').addEventListener('click',()=>{applySettings(defaults);rememberSettings();toast('Back to your starting recipe.');});
$('auto-tempo').addEventListener('click',()=>{$('bpm').value='';rememberSettings();});
$('remix-form').addEventListener('submit',async e=>{e.preventDefault();if(state.submitting)return;state.submitting=true;error('');render();
  try{const s=settings();s.seed=crypto.getRandomValues(new Uint32Array(1))[0];const result=await api('/api/jobs',{track_id:state.trackId,settings:s});state.pending=result.id;await refresh();}
  catch(exc){error(exc.message);}finally{state.submitting=false;render();}});
$('favorite').addEventListener('click',async()=>{const j=job();if(!j)return;try{await api('/api/jobs/'+j.id+'/favorite',{favorite:!j.favorite});await refresh();}catch(exc){error(exc.message);}});
$('retry-analysis').addEventListener('click',async()=>{try{await api('/api/tracks/'+state.trackId+'/retry',{});await refresh();}catch(exc){error(exc.message);}});
$('match-volume').addEventListener('change',volumeMatch);
$('remix-volume').addEventListener('input',volumeMatch);
$('remix-play').addEventListener('click',()=>{if(remixAudio.error){if(job())loadRemix(job());return;}
  if(remixAudio.paused)remixAudio.play().catch(exc=>toast(exc.message));else remixAudio.pause();});
$('cancel-cue').addEventListener('click',()=>remixAudio.cancelQueue());
$('jump-return').addEventListener('click',()=>{const s=job()?.result.sections.find(s=>/main|return/i.test(s.name));if(s)playAt(s.start,s.name);});
sourceAudio.addEventListener('play',()=>remixAudio.pause());remixAudio.addEventListener('play',()=>sourceAudio.pause());
remixAudio.addEventListener('timeupdate',updatePlayhead);
for(const event of ['play','pause','queuechange','sectionchange','loading','loadedmetadata','error'])remixAudio.addEventListener(event,renderTransport);
$('waveform').addEventListener('click',e=>{const box=e.currentTarget.getBoundingClientRect();if(Number.isFinite(remixAudio.duration))remixAudio.currentTime=Math.max(0,Math.min(1,(e.clientX-box.left)/box.width))*remixAudio.duration;});
$('waveform').addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End',' '].includes(e.key))return;e.preventDefault();
  if(e.key===' ')return remixAudio.paused?remixAudio.play().catch(()=>{}):remixAudio.pause();
  const d=remixAudio.duration;if(!Number.isFinite(d))return;remixAudio.currentTime=e.key==='Home'?0:e.key==='End'?d:Math.max(0,Math.min(d,remixAudio.currentTime+(e.key==='ArrowRight'?5:-5)));});
(async()=>{try{const config=await api('/api/config');state.token=config.token;
  try{const saved=JSON.parse(localStorage.getItem('afterhours-settings'));if(saved)applySettings(saved);}catch{}
  sliderLabels();await poll();
}catch{error('Could not connect to the studio. Start the app on your Mac and refresh this page.');}})();
