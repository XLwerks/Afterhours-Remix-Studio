'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const BeatPlayer=require('./web/beat-player.js');
const Mixer=require('./web/mixer.js');
class Param{
  constructor(){this.value=1;this.events=[];}
  setValueAtTime(value,time){this.events.push({kind:'set',value,time});return this;}
  linearRampToValueAtTime(value,time){this.events.push({kind:'ramp',value,time});return this;}
  setTargetAtTime(value,time){this.events.push({kind:'set',value,time});return this;}
  cancelScheduledValues(time){this.events=this.events.filter(e=>e.time<time);return this;}
  at(time){let value=this.value,lastTime=0;
    for(const e of [...this.events].sort((a,b)=>a.time-b.time)){
      if(e.time>time)return e.kind==='ramp'?value+(e.value-value)*(time-lastTime)/(e.time-lastTime):value;
      value=e.value;lastTime=e.time;
    }return value;}
}
class Context{
  constructor(){this.currentTime=0;this.destination={};this.sources=[];this.duration=112.94117647058823;}
  createGain(){return{gain:new Param(),connect(){},disconnect(){}};}
  createBufferSource(){const s={stops:[],connect(g){this.g=g;},disconnect(){},start(when,offset){this.startTime=when;this.offset=offset;},stop(when){this.stops.push(when);}};this.sources.push(s);return s;}
  async resume(){}
  async decodeAudioData(){return{duration:this.duration};}
}
async function ready(bpm=136){const ctx=new Context();const p=new BeatPlayer({contextFactory:()=>ctx,ticking:false,fetcher:async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(8)})});await p.load('/remix.wav',bpm);return{p,ctx};}
const close=(a,b,tol=1e-9)=>assert.ok(Math.abs(a-b)<tol,`${a} != ${b}`);

async function mixReady(){const ctx=new Context(),m=new Mixer({contextFactory:()=>ctx,ticking:false,fetcher:async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(8)})});
  m.bpm=120;await m.load(0,'a',120);await m.load(1,'b',120);return{m,ctx};}
test('two decks share an audio clock: A to B to A stays on the grid',async()=>{
  const{m,ctx}=await mixReady();const first=await m.launch(0,0,'Intro');ctx.currentTime=first+.1;
  const a=m.decks[0];a.settle();const oldA=a.voice;const bTime=await m.launch(1,16,'Groove');close((bTime-first)/.5,Math.round((bTime-first)/.5));
  assert.equal(a.voice,oldA);assert.equal(oldA.source.stops.length,0);
  ctx.currentTime=bTime+.1;m.decks[1].settle();m.settle();close(m.fader,1);
  const oldB=m.decks[1].voice;const aTime=await m.launch(0,32,'Return');ctx.currentTime=aTime+.1;m.decks[0].settle();m.settle();
  close(m.fader,0);assert.equal(m.decks[1].voice,oldB);assert.equal(oldB.source.stops.length,0);close(m.decks[0].currentTime,32.1);
});
test('reload silent A while B plays preserves B voice, position and shared epoch',async()=>{
  const{m,ctx}=await mixReady();await m.launch(1,0,'Intro');ctx.currentTime=1;m.decks[1].settle();m.settle();
  const b=m.decks[1],voice=b.voice,epoch=m.epoch,pos=b.currentTime;
  await m.load(0,'another-track',120);assert.equal(b.voice,voice);close(b.currentTime,pos);assert.equal(m.epoch,epoch);assert.equal(voice.source.stops.length,0);
});
test('cut to a running standby deck preserves its position rather than restarting it',async()=>{
  const{m,ctx}=await mixReady();await m.launch(0,0,'Intro');ctx.currentTime=1;m.decks[0].settle();
  await m.launch(1,16,'Groove',{cut:false});ctx.currentTime=2;m.decks[1].settle();const voice=m.decks[1].voice;
  const when=await m.take(1);ctx.currentTime=when+.05;m.settle();assert.equal(m.decks[1].voice,voice);close(m.fader,1);
});
test('queued deck launch and mixer cut cancel together without stopping the outgoing deck',async()=>{
  const{m,ctx}=await mixReady();await m.launch(0,0,'Intro');ctx.currentTime=1;m.decks[0].settle();m.settle();const voice=m.decks[0].voice;
  await m.launch(1,16,'Groove');const next=m.decks[1].pending;m.cancel();
  assert.equal(m.decks[1].paused,true);assert.equal(m.transition,null);assert.equal(m.decks[0].voice,voice);assert.equal(voice.source.stops.length,0);assert.ok(next.voice.source.stops.length);close(m.gains[0].gain.at(10),1);
});
test('bar mode launches on the next shared four-beat boundary',async()=>{
  const{m,ctx}=await mixReady();const epoch=await m.launch(0,0,'Intro');ctx.currentTime=epoch+.7;m.decks[0].settle();
  const when=await m.launch(1,16,'Groove',{quantise:4});close(when,epoch+2);
});
test('linear crossfader and scheduled cuts keep combined gain bounded',async()=>{
  const{m,ctx}=await mixReady();m.blend(.4);close(m.gains[0].gain.at(.02)+m.gains[1].gain.at(.02),1);
  await m.launch(0,0,'Intro');ctx.currentTime=1;m.decks[0].settle();m.settle();const when=await m.launch(1,0,'Intro');
  for(let t=when;t<when+.012;t+=.001)close(m.gains[0].gain.at(t)+m.gains[1].gain.at(t),1);
});
test('tempo cannot change during playback; mismatched deck tempo cannot launch',async()=>{
  const{m,ctx}=await mixReady();await m.launch(0,0,'Intro');assert.throws(()=>m.setTempo(130),/Pause/);m.stop();m.setTempo(130);
  await m.load(1,'wrong',120);await assert.rejects(m.launch(1,0,'Intro'),/set BPM/);
});
test('pause both while audio context resumes prevents later playback',async()=>{
  const{m,ctx}=await mixReady();let release;ctx.resume=()=>new Promise(r=>release=r);const pending=m.launch(0,0,'Intro');m.stop();release();await pending;assert.equal(m.active,false);
});
test('replace queued B choice: only the newest section plays and A continues',async()=>{
  const{m,ctx}=await mixReady();await m.launch(0,0,'Intro');ctx.currentTime=1;m.decks[0].settle();m.settle();
  await m.launch(1,16,'Groove');const abandoned=m.decks[1].pending;await m.launch(1,32,'Build');
  assert.ok(abandoned.voice.source.stops.length);assert.equal(m.decks[1].queued.name,'Build');close(m.decks[1].pending.voice.offset,32);assert.equal(m.decks[0].paused,false);
});

test('playing section changes schedule on the next source beat, with exact rounded destinations',async()=>{
  const{p,ctx}=await ready();await p.play();const old=p.voice;ctx.currentTime=1.1;
  const expected=old.when+Math.ceil((p.currentTime+p.lead)/(60/136))*(60/136);
  await p.queueSection(56.471,'Build');const q=p.pending;
  close(q.when,expected);close(q.voice.offset,128*60/136);
  assert.ok(q.when>ctx.currentTime);assert.equal(p.voice,old);assert.equal(old.source.stops.length,0);
  assert.equal(q.voice.source.startTime,q.when);assert.equal(p.queued.name,'Build');p.pause();
});
test('brief linear overlap has no silence or doubled gain at the transition',async()=>{
  const{p,ctx}=await ready(120);await p.play();ctx.currentTime=.2;const old=p.voice;
  await p.queueSection(16,'Groove');const q=p.pending;
  for(let t=q.when;t<=q.when+p.fade;t+=1/48000)close(old.gain.gain.at(t)+q.voice.gain.gain.at(t),1,1e-8);
  close(old.gain.gain.at(q.when-.002),1);close(q.voice.gain.gain.at(q.when+p.fade+.002),1);p.pause();
});
test('late UI updates do not move scheduled audio or reset the new playback clock',async()=>{
  const{p,ctx}=await ready(120);await p.play();ctx.currentTime=.2;await p.queueSection(16,'Groove');
  const q=p.pending;ctx.currentTime=q.when+.31;
  // The audio automation already has full incoming gain, before any UI settlement.
  close(q.voice.gain.gain.at(ctx.currentTime),1);close(p.voice.gain.gain.at(ctx.currentTime),0);
  close(p.currentTime,16+.31);assert.equal(p.pending,null);p.pause();
});
test('the most recent click replaces a pending cue without stopping the outgoing music',async()=>{
  const{p,ctx}=await ready(120);await p.play();ctx.currentTime=.15;const old=p.voice;
  await p.queueSection(16,'Groove');const abandoned=p.pending;ctx.currentTime=.21;
  await p.queueSection(32,'Build');assert.equal(p.queued.name,'Build');
  close(p.pending.when,abandoned.when);assert.ok(abandoned.voice.source.stops[0]<abandoned.when);
  assert.equal(old.source.stops.length,0);close(old.gain.gain.at(.3),1);p.pause();
});
test('cancel restores continuous outgoing gain and removes the scheduled incoming source',async()=>{
  const{p,ctx}=await ready(120);await p.play();ctx.currentTime=.1;const old=p.voice;
  await p.queueSection(16,'Groove');const cue=p.pending;p.cancelQueue();
  assert.equal(p.queued,null);close(old.gain.gain.at(cue.when+.5),1);assert.ok(cue.voice.source.stops.length);p.pause();
});
test('pause cancels a pending jump, and resume keeps the current position',async()=>{
  const{p,ctx}=await ready(120);await p.play();ctx.currentTime=.2;await p.queueSection(16,'Groove');
  const q=p.pending;p.pause();assert.equal(p.queued,null);assert.ok(q.voice.source.stops.length);
  close(p.currentTime,.195);ctx.currentTime=10;await p.play();close(p.voice.offset,.195);p.pause();
});
test('section selection while paused starts at that section without an artificial beat wait',async()=>{
  const{p,ctx}=await ready(120);ctx.currentTime=3;await p.queueSection(16,'Groove');
  assert.equal(p.queued,null);assert.equal(p.paused,false);close(p.voice.offset,16);close(p.voice.when,3.005);p.pause();
});
test('manual seeking cancels the pending cue',async()=>{
  const{p,ctx}=await ready(120);await p.play();ctx.currentTime=.2;await p.queueSection(16,'Groove');
  const q=p.pending;p.currentTime=10;assert.equal(p.queued,null);close(p.voice.offset,10);assert.ok(q.voice.source.stops.length);p.pause();
});
test('track change invalidates in-flight loading and prevents stale audio replacing the selection',async()=>{
  const ctx=new Context();let firstResolve;
  const p=new BeatPlayer({contextFactory:()=>ctx,ticking:false,fetcher:url=>url==='one'?new Promise(r=>firstResolve=r):Promise.resolve({ok:true,arrayBuffer:async()=>new ArrayBuffer(8)})});
  const first=p.load('one',100);await p.load('two',136);const current=p.buffer;
  firstResolve({ok:true,arrayBuffer:async()=>new ArrayBuffer(8)});await first;assert.equal(p.buffer,current);assert.equal(p.bpm,136);p.clear();
});
test('pausing while the audio context resumes cannot restart playback later',async()=>{
  const{p,ctx}=await ready();let resume;ctx.resume=()=>new Promise(r=>resume=r);
  const attempt=p.play();p.pause();resume();await attempt;assert.equal(p.paused,true);assert.equal(p.voice,null);
});
test('clicking close to the next beat gives the audio engine safe scheduling time',async()=>{
  const{p,ctx}=await ready(120);await p.play();ctx.currentTime=.501;
  await p.queueSection(16,'Groove');close(p.pending.when,1.005);p.pause();
});
test('the final ending beat can launch a queued section without adding an empty beat',async()=>{
  const{p,ctx}=await ready(120);ctx.duration=32;p.buffer.duration=32;await p.play();ctx.currentTime=32.001;
  await p.queueSection(16,'Groove');close(p.pending.when,32.005);p.pause();
});
test('natural playback completion ends cleanly, and invalid cues cannot cut the audio',async()=>{
  const{p,ctx}=await ready();await p.play();const voice=p.voice;
  await assert.rejects(()=>p.queueSection(-2));assert.equal(p.voice,voice);
  ctx.currentTime=voice.when+p.duration;voice.source.onended();assert.equal(p.paused,true);close(p.currentTime,p.duration);p.clear();
});
test('unavailable files leave a retryable error instead of an unhandled half-loaded player',async()=>{
  const p=new BeatPlayer({contextFactory:()=>new Context(),ticking:false,fetcher:async()=>({ok:false})});
  await assert.rejects(()=>p.load('/missing.wav',136));assert.ok(p.error);assert.equal(p.ready,false);assert.equal(p.loading,false);p.clear();
});
