'use strict';
(() => {
  const mixer=new AfterhoursMixer();
  let crate={bpm:136,ids:[]},initialised=false,saving=false,libraryKey='',crateKey='',tempoBusy=false;
  const decks=[0,1].map(index=>{
    const root=$('deck-template').content.firstElementChild.cloneNode(true),letter=index?'B':'A';
    root.dataset.deck=letter;root.setAttribute('aria-label','Deck '+letter);root.querySelector('.deck-letter').textContent='DECK '+letter;
    const select=root.querySelector('select');select.setAttribute('aria-label','Choose remix for deck '+letter);
    root.querySelector('.deck-load').textContent='Load '+letter;
    root.querySelector('.deck-load').addEventListener('click',()=>load(index,select.value));
    root.querySelector('.deck-play').addEventListener('click',()=>{
      const p=mixer.decks[index];if(!p?.ready)return;
      if(!p.paused)mixer.pause(index);else launch(index,p.currentTime>=p.duration-.01?0:p.currentTime,'Play');
    });
    $('decks').append(root);return{root,select,id:null,prepared:null,loading:false,generation:0,message:''};
  });
  const title=j=>(state.tracks.find(t=>t.id===j.track_id)?.name||'Track')+' — '+j.name;
  const safe=fn=>Promise.resolve().then(fn).catch(e=>toast(e.message));
  function ensure(){mixer.ensure();if(ensure.done)return;ensure.done=true;
    for(const p of mixer.decks){for(const event of ['timeupdate','play','pause','queuechange','loadedmetadata','error'])p.addEventListener(event,paint);}
  }
  function audible(index){return !!mixer.decks[index]&&!mixer.decks[index].paused&&(index?mixer.valueAt(mixer.context.currentTime):1-mixer.valueAt(mixer.context.currentTime))>.001;}
  async function save(next){
    if(saving)throw Error('Your last crate change is still saving. Try again in a moment.');
    saving=true;paint();
    try{await api('/api/setlist',next);crate=next;crateKey='';renderCrate();}
    finally{saving=false;paint();}
  }
  function renderCrate(){
    const ready=state.jobs.filter(j=>j.status==='done'),key=JSON.stringify(ready.map(j=>[j.id,j.name,j.favorite]))+JSON.stringify(crate);
    if(key===crateKey)return;crateKey=key;
    const previous=$('crate-choice').value;$('crate-choice').replaceChildren();
    for(const j of ready.filter(j=>!crate.ids.includes(j.id))){const o=element('option','',title(j)+' · '+j.result.bpm+' BPM');o.value=j.id;$('crate-choice').append(o);}
    if([...$('crate-choice').options].some(o=>o.value===previous))$('crate-choice').value=previous;
    $('crate-count').textContent=crate.ids.length+' remixes';$('crate-list').replaceChildren();
    for(const [position,id] of crate.ids.entries()){
      const j=state.jobs.find(j=>j.id===id);if(!j)continue;
      const row=element('div','crate-row'),detail=element('div','crate-detail');detail.append(element('strong','',title(j)),element('small','',j.result.bpm+' BPM · '+time(j.result.duration)));row.append(element('span','version-number',String(position+1).padStart(2,'0')),detail);
      const actions=element('div','crate-actions');
      for(const index of [0,1]){const b=element('button','secondary','Load '+(index?'B':'A'));b.dataset.loadDeck=index;b.addEventListener('click',()=>load(index,id));actions.append(b);}
      for(const [label,delta] of [['↑',-1],['↓',1]]){const b=element('button','text-button',label);b.setAttribute('aria-label','Move '+title(j)+(delta<0?' up':' down'));b.disabled=position+delta<0||position+delta>=crate.ids.length;
        b.addEventListener('click',()=>safe(()=>{const ids=[...crate.ids];[ids[position],ids[position+delta]]=[ids[position+delta],ids[position]];return save({...crate,ids});}));actions.append(b);}
      const remove=element('button','text-button','Remove');remove.setAttribute('aria-label','Remove '+title(j)+' from crate');remove.addEventListener('click',()=>safe(()=>save({...crate,ids:crate.ids.filter(i=>i!==id)})));actions.append(remove);row.append(actions);$('crate-list').append(row);
    }
    if(!crate.ids.length)$('crate-list').append(element('p','empty-versions','Choose a saved remix above to begin. Removing an entry here never deletes your music.'));
    for(const d of decks){const selected=d.select.value;d.select.replaceChildren();
      d.select.append(element('option','','Choose from your crate…'));d.select.firstChild.value='';
      for(const id of crate.ids){const j=state.jobs.find(j=>j.id===id);if(!j)continue;const o=element('option','',title(j));o.value=id;d.select.append(o);}
      d.select.value=crate.ids.includes(selected)?selected:crate.ids.includes(d.id)?d.id:'';
    }
    paint();
  }
  function load(index,id){return safe(async()=>{
    const j=state.jobs.find(j=>j.id===id&&j.status==='done');if(!j)throw Error('Choose a remix from your crate first.');
    if(tempoBusy)throw Error('Wait for the set BPM to finish saving.');
    ensure();mixer.settle();
    if(audible(index))throw Error('This deck is audible. Cut or fade to the other deck, or pause this deck before replacing it.');
    const d=decks[index],generation=++d.generation;mixer.pause(index);mixer.decks[index].clear();d.id=id;d.prepared=null;d.loading=true;d.message='Preparing at '+crate.bpm+' BPM…';
    d.select.value=id;d.root.querySelector('.deck-title').textContent=title(j);d.root.querySelector('.deck-sections').replaceChildren();paint();
    try{
      const prepared=await api('/api/prepare-deck',{id,bpm:crate.bpm});if(generation!==d.generation)return;
      d.message='Loading prepared audio…';paint();await mixer.load(index,prepared.url,prepared.bpm,prepared.duration);if(generation!==d.generation)return;
      d.prepared=prepared;d.message='Ready. Choose a section or press Play.';
      d.root.querySelector('.deck-meta').textContent=prepared.bpm+' BPM · '+time(prepared.duration)+(Math.abs(prepared.source_bpm-prepared.bpm)>.01?' · prepared from '+prepared.source_bpm+' BPM':'');
      const download=d.root.querySelector('.deck-download');download.href=prepared.url+'?download=1';
      for(const s of prepared.sections){const b=element('button','section-button');b.dataset.start=s.start;b.dataset.end=s.end;b.dataset.name=s.name;b.append(element('span','',s.name),element('small','',time(s.start)));b.addEventListener('click',()=>launch(index,s.start,s.name));d.root.querySelector('.deck-sections').append(b);}
    }catch(e){if(generation!==d.generation)return;d.message='Could not load. Press Load to retry.';throw e;}
    finally{if(generation===d.generation){d.loading=false;paint();}}
  });}
  function launch(index,seconds,name){return safe(async()=>{
    sourceAudio.pause();remixAudio.pause();
    await mixer.launch(index,seconds,name,{cut:$('cut-on-launch').checked,quantise:Number($('mix-grid').value)});paint();
  });}
  function paint(){
    mixer.settle();
    const now=mixer.context?.currentTime||0,balance=mixer.valueAt(now);
    if(document.activeElement!==$('crossfader'))$('crossfader').value=balance*100;
    $('mix-balance').textContent=balance<.001?'A only':balance>.999?'B only':'Blend '+Math.round((1-balance)*100)+' / '+Math.round(balance*100);
    const busy=tempoBusy||decks.some(d=>d.loading);$('set-bpm').disabled=mixer.active||busy;$('save-set-bpm').disabled=mixer.active||busy||saving;
    $('crate-add').disabled=saving||!$('crate-choice').value;
    for(const [index,d] of decks.entries()){
      const p=mixer.decks[index],current=p?.currentTime||0,queued=p?.queued,ready=!!p?.ready&&!d.loading;
      d.root.classList.toggle('on-air',audible(index));
      d.root.querySelector('.deck-state').textContent=d.loading?'PREPARING':queued?'QUEUED':audible(index)?'ON AIR':p&&!p.paused?'RUNNING · MUTED':ready?'READY':'EMPTY';
      const play=d.root.querySelector('.deck-play');play.disabled=!ready;play.textContent=p&&!p.paused?'Ⅱ Pause':'▶ Play';play.setAttribute('aria-label',(p&&!p.paused?'Pause':'Play')+' deck '+(index?'B':'A'));
      d.root.querySelector('.deck-time').textContent=time(current)+' / '+time(p?.duration||0);
      d.root.querySelector('.deck-beat').textContent=p&&!p.paused&&!queued?((Math.floor((current+.00001)/(60/mixer.bpm))%4)+1)+' / 4':'— / 4';
      d.root.querySelector('.deck-progress').value=current/(p?.duration||1);
      d.root.querySelector('.deck-message').textContent=queued?'Queued: '+queued.name+' — next '+($('mix-grid').value==='4'?'bar':'beat'):d.message;
      d.root.querySelector('.deck-download').hidden=!d.prepared;
      d.root.querySelector('.deck-load').disabled=d.loading||audible(index)||tempoBusy;
      for(const b of d.root.querySelectorAll('.section-button')){b.disabled=!ready;const active=current>=Number(b.dataset.start)-.003&&current<Number(b.dataset.end)-.003;
        b.classList.toggle('active-section',active);b.classList.toggle('queued-section',queued?.name===b.dataset.name);b.setAttribute('aria-label','Deck '+(index?'B':'A')+': '+b.dataset.name);}
    }
    for(const b of document.querySelectorAll('[data-load-deck]')){const i=Number(b.dataset.loadDeck);b.disabled=decks[i].loading||audible(i)||tempoBusy;}
    $('cut-a').disabled=!mixer.decks[0]?.ready;$('cut-b').disabled=!mixer.decks[1]?.ready;
    const pending=mixer.decks.some(p=>p.queued)||mixer.transition;$('cancel-mix').hidden=!pending;
    $('mix-cue').textContent=mixer.transition?'Switch queued → Deck '+(mixer.transition.index?'B':'A'):pending?'Section launch queued.':'';
    $('mix-status').textContent=busy?'Preparing audio locally. The playing deck is unaffected.':saving?'Saving your crate…':mixer.active?'Live at '+mixer.bpm+' BPM. Load your next choice into the silent deck.':'Set tempo: '+crate.bpm+' BPM. Load a deck and choose a section to start.';
  }
  mixer.addEventListener('change',paint);
  $('crossfader').addEventListener('input',e=>{ensure();mixer.blend(Number(e.target.value)/100);});
  $('cancel-mix').addEventListener('click',()=>mixer.cancel());$('stop-decks').addEventListener('click',()=>mixer.stop());
  for(const index of [0,1])$(index?'cut-b':'cut-a').addEventListener('click',()=>safe(async()=>{
    sourceAudio.pause();remixAudio.pause();await mixer.take(index,Number($('mix-grid').value));paint();
  }));
  $('crate-add').addEventListener('click',()=>safe(()=>{const id=$('crate-choice').value;if(!id||crate.ids.includes(id))return;return save({...crate,ids:[...crate.ids,id]});}));
  $('save-set-bpm').addEventListener('click',()=>safe(async()=>{
    const bpm=Number($('set-bpm').value);if(!Number.isFinite(bpm)||bpm<70||bpm>180)throw Error('Choose a BPM from 70 to 180.');
    if(mixer.active||decks.some(d=>d.loading))throw Error('Pause both decks before changing the set BPM.');
    tempoBusy=true;paint();try{await save({...crate,bpm:Math.round(bpm*10)/10});mixer.setTempo(crate.bpm);for(const d of decks){d.generation++;d.prepared=null;d.message='Reload this deck at the new set BPM.';}toast('Set BPM saved. Reload your decks when ready.');}finally{tempoBusy=false;paint();}
  }));
  sourceAudio.addEventListener('play',()=>mixer.stop());remixAudio.addEventListener('play',()=>mixer.stop());
  globalThis.afterhoursLive={refresh(data){if(!initialised){crate=data.setlist||crate;mixer.bpm=crate.bpm;$('set-bpm').value=crate.bpm;initialised=true;}renderCrate();},mixer};
  if(state.connected)globalThis.afterhoursLive.refresh({});paint();
})();
