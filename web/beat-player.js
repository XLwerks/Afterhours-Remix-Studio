/* Beat-quantised playback. Audio nodes, not UI timers, execute every transition. */
'use strict';
(() => {
  class BeatPlayer extends EventTarget {
    constructor({contextFactory, fetcher, ticking=true, output}={}) {
      super();
      this.contextFactory=contextFactory||(()=>new (globalThis.AudioContext||globalThis.webkitAudioContext)({latencyHint:'interactive'}));
      this.fetcher=fetcher||((...args)=>fetch(...args));
      this.output=output;this.ticking=ticking; this.context=null; this.master=null; this.buffer=null;
      this.voice=null; this.pending=null; this.voices=new Set(); this.offset=0;
      this.playing=false; this.loading=false; this.error=null; this.bpm=120;
      this.generation=0; this.intent=0; this.level=1; this.fade=.006; this.lead=.012;
      this.controller=null; this.timer=null; this.reportedDuration=0;
    }
    emit(type) { this.dispatchEvent(new Event(type)); }
    ensureContext() {
      if(!this.context){this.context=this.contextFactory();this.master=this.context.createGain();
        this.master.gain.value=this.level;this.master.connect(this.output||this.context.destination);}
      return this.context;
    }
    get ready(){return !!this.buffer&&!this.loading&&!this.error;}
    get paused(){return !this.playing;}
    get duration(){return this.buffer?.duration||this.reportedDuration;}
    get volume(){return this.level;}
    set volume(value){this.level=Math.max(0,Math.min(1,Number(value)||0));
      if(this.master)this.master.gain.setTargetAtTime(this.level,this.context.currentTime,.005);}
    get currentTime(){this.settle();return this.position();}
    set currentTime(value){this.seek(value);}
    get queued(){this.settle();return this.pending?{name:this.pending.name,start:this.pending.voice.offset,when:this.pending.when}:null;}
    position(){return this.playing&&this.voice?Math.min(this.duration,this.voice.offset+Math.max(0,this.context.currentTime-this.voice.when)):this.offset;}
    async load(url,bpm,duration=0) {
      this.clear();const generation=this.generation;
      this.bpm=Number(bpm);this.reportedDuration=duration;
      this.loading=true;this.emit('loading');this.controller=new AbortController();
      try {
        if(!Number.isFinite(this.bpm)||this.bpm<=0)throw Error('This remix is missing its tempo. Choose another version.');
        const context=this.ensureContext();
        const response=await this.fetcher(url,{signal:this.controller.signal});
        if(!response.ok)throw Error('The remix could not be loaded. Please try again.');
        const buffer=await context.decodeAudioData(await response.arrayBuffer());
        if(generation!==this.generation)return;
        this.buffer=buffer;this.loading=false;this.emit('loadedmetadata');this.emit('timeupdate');
      } catch(error) {
        if(generation!==this.generation)return;
        this.loading=false;this.error=error;this.emit('error');throw error;
      }
    }
    clear(){this.generation++;this.pause();this.controller?.abort();this.buffer=null;
      this.reportedDuration=0;this.offset=0;this.error=null;this.loading=false;}
    makeVoice(when,offset) {
      const source=this.context.createBufferSource(),gain=this.context.createGain();
      source.buffer=this.buffer;source.connect(gain);gain.connect(this.master);
      gain.gain.setValueAtTime(0,when);gain.gain.linearRampToValueAtTime(1,when+this.fade);
      const voice={source,gain,when,offset};this.voices.add(voice);
      source.onended=()=>{this.voices.delete(voice);source.disconnect();gain.disconnect();
        this.settle();
        if(this.voice===voice&&!this.pending&&this.playing){this.offset=this.duration;this.playing=false;
          this.voice=null;this.stopTicker();this.emit('pause');this.emit('ended');this.emit('timeupdate');}};
      source.start(when,offset);
      return voice;
    }
    stopVoice(voice,when=this.context.currentTime){try{voice.source.stop(when);}catch{} }
    startTicker(){if(this.ticking&&!this.timer)this.timer=setInterval(()=>{this.settle();this.emit('timeupdate');},33);}
    stopTicker(){if(this.timer)clearInterval(this.timer);this.timer=null;}
    async play(){
      if(!this.ready)throw Error('The remix is still loading. Try play in a moment.');
      if(this.playing)return;
      const intent=++this.intent,generation=this.generation;
      await this.ensureContext().resume();
      if(intent!==this.intent||generation!==this.generation)return;
      const offset=this.offset>=this.duration-.001?0:this.offset;
      this.voice=this.makeVoice(this.context.currentTime+.005,offset);
      this.playing=true;this.startTicker();this.emit('play');this.emit('timeupdate');
    }
    pause(){
      this.intent++;this.settle();this.offset=this.position();
      const wasPlaying=this.playing;
      this.playing=false;this.pending=null;this.voice=null;
      if(this.context){const now=this.context.currentTime;
        for(const v of this.voices){v.gain.gain.cancelScheduledValues(now);v.gain.gain.setValueAtTime(0,now);this.stopVoice(v,now);}}
      this.voices.clear();this.stopTicker();this.emit('queuechange');
      if(wasPlaying)this.emit('pause');this.emit('timeupdate');
    }
    settle(){
      if(!this.pending||this.context.currentTime<this.pending.when)return;
      const pending=this.pending,old=this.voice;
      this.pending=null;this.voice=pending.voice;this.offset=pending.voice.offset;
      // Outgoing gain was already scheduled to fade. A delayed UI tick cannot delay the audio jump.
      if(old)this.stopVoice(old,Math.max(this.context.currentTime,pending.when+this.fade));
      this.emit('queuechange');this.emit('sectionchange');
    }
    cancelQueue(){
      this.intent++;this.settle();if(!this.pending)return;
      const pending=this.pending;this.pending=null;
      this.stopVoice(pending.voice);
      if(this.voice){this.voice.gain.gain.cancelScheduledValues(pending.when);
        this.voice.gain.gain.setValueAtTime(1,pending.when);}
      else{this.playing=false;this.stopTicker();this.emit('pause');}
      this.emit('queuechange');
    }
    // A shared mixer can schedule either an idle deck or a playing deck against its own clock.
    scheduleSection(seconds,name,when){
      if(!this.ready)throw Error('Wait for this deck to finish loading.');
      const beat=60/this.bpm,offset=Math.round(Number(seconds)/beat)*beat;
      if(!Number.isFinite(offset)||offset<0||offset>=this.duration)throw Error('This section is outside the remix.');
      if(!Number.isFinite(when)||when<this.ensureContext().currentTime)throw Error('The launch time has passed. Try again.');
      this.cancelQueue();
      const next=this.makeVoice(when,offset);
      if(this.voice){this.voice.gain.gain.setValueAtTime(1,when);this.voice.gain.gain.linearRampToValueAtTime(0,when+this.fade);}
      this.pending={voice:next,when,name};this.playing=true;this.startTicker();this.emit('play');this.emit('queuechange');
      return when;
    }
    seek(seconds){
      if(!Number.isFinite(Number(seconds)))return;
      this.cancelQueue();this.offset=Math.max(0,Math.min(this.duration,Number(seconds)));
      if(this.playing&&this.ready){
        const old=this.voice,now=this.context.currentTime;
        if(this.offset>=this.duration){this.pause();this.offset=this.duration;this.emit('timeupdate');return;}
        const when=now+.005;
        this.voice=this.makeVoice(when,this.offset);
        if(old){old.gain.gain.cancelScheduledValues(when);old.gain.gain.setValueAtTime(1,when);
          old.gain.gain.linearRampToValueAtTime(0,when+this.fade);this.stopVoice(old,when+this.fade);}
      }
      this.emit('timeupdate');
    }
    async queueSection(seconds,name='Section'){
      if(!this.ready)throw Error('The remix is still loading. Try again in a moment.');
      const beat=60/this.bpm;
      // Saved section timestamps are rounded to milliseconds; restore the exact beat position.
      const offset=Math.round(Number(seconds)/beat)*beat;
      if(!Number.isFinite(offset)||offset<0||offset>=this.duration)throw Error('This section is outside the remix.');
      this.settle();this.cancelQueue();
      if(!this.playing){this.offset=offset;await this.play();return;}
      const now=this.context.currentTime,pos=this.position();
      let nextBeat=(Math.floor((pos+this.lead)/beat)+1)*beat;
      // At the final beat, use the ending grid line rather than introducing an empty extra beat.
      const endBeat=Math.round(this.duration/beat)*beat;
      if(nextBeat>this.duration&&Math.abs(endBeat-this.duration)<.003&&endBeat>pos)nextBeat=endBeat;
      const when=Math.max(now,this.voice.when+nextBeat-this.voice.offset);
      const next=this.makeVoice(when,offset);
      this.voice.gain.gain.setValueAtTime(1,when);
      this.voice.gain.gain.linearRampToValueAtTime(0,when+this.fade);
      this.pending={voice:next,when,name};this.emit('queuechange');
    }
  }
  globalThis.AfterhoursBeatPlayer=BeatPlayer;
  if(typeof module!=='undefined'&&module.exports)module.exports=BeatPlayer;
})();
