'use strict';
(() => {
  const Player=globalThis.AfterhoursBeatPlayer||(typeof require==='function'?require('./beat-player.js'):null);
  class Mixer extends EventTarget {
    constructor({contextFactory,fetcher,ticking=true}={}){
      super();this.contextFactory=contextFactory||(()=>new (globalThis.AudioContext||globalThis.webkitAudioContext)({latencyHint:'interactive'}));
      this.fetcher=fetcher;this.ticking=ticking;this.context=null;this.decks=[];this.gains=[];
      this.bpm=136;this.epoch=null;this.fader=0;this.transition=null;this.intent=0;
    }
    ensure(){if(this.context)return;
      this.context=this.contextFactory();
      this.gains=[0,1].map(i=>{const g=this.context.createGain();g.gain.value=i?0:1;g.connect(this.context.destination);return g;});
      this.decks=this.gains.map(output=>new Player({contextFactory:()=>this.context,output,fetcher:this.fetcher,ticking:this.ticking}));
    }
    emit(){this.dispatchEvent(new Event('change'));}
    get active(){return this.decks.some(p=>!p.paused);}
    setTempo(bpm){
      if(this.active)throw Error('Pause both decks before changing the set BPM.');
      if(!Number.isFinite(bpm)||bpm<70||bpm>180)throw Error('Choose a set BPM from 70 to 180.');
      this.cancel();this.bpm=bpm;this.epoch=null;this.decks.forEach(p=>p.clear());
    }
    settle(){
      if(this.transition&&this.context.currentTime>=this.transition.when+.012){
        this.fader=this.transition.to;this.transition=null;this.emit();
      }
    }
    valueAt(now){const t=this.transition;if(!t)return this.fader;
      return t.from+(t.to-t.from)*Math.max(0,Math.min(1,(now-t.when)/.012));}
    cancelCut(){if(!this.context)return;const now=this.context.currentTime,value=this.valueAt(now);
      this.transition=null;this.fader=value;
      this.gains.forEach((g,i)=>{g.gain.cancelScheduledValues(now);g.gain.setValueAtTime(i?value:1-value,now);});
    }
    cancel(){this.intent++;this.cancelCut();this.decks.forEach(p=>p.cancelQueue());this.emit();}
    blend(value){this.cancelCut();this.fader=Math.max(0,Math.min(1,value));
      if(this.context){const now=this.context.currentTime;this.gains.forEach((g,i)=>g.gain.linearRampToValueAtTime(i?this.fader:1-this.fader,now+.012));}
      this.emit();
    }
    async launch(index,seconds,name,{cut=true,quantise=1}={}){
      this.ensure();const p=this.decks[index];
      if(!p?.ready)throw Error('Load a remix into this deck first.');
      if(Math.abs(p.bpm-this.bpm)>.001)throw Error('Load this remix again at the set BPM.');
      this.cancel();const intent=this.intent,generation=p.generation;
      await this.context.resume();
      if(intent!==this.intent||generation!==p.generation)return;
      const now=this.context.currentTime,beat=60/this.bpm,grid=beat*(quantise===4?4:1);
      if(!this.active||this.epoch===null)this.epoch=now+.025;
      const when=this.epoch+Math.max(0,Math.ceil((now+.025-this.epoch)/grid))*grid;
      p.scheduleSection(seconds,name,when);
      if(cut){this.cancelCut();this.transition={index,from:this.fader,to:index,when};
        this.gains.forEach((g,i)=>{g.gain.setValueAtTime(i?this.fader:1-this.fader,when);g.gain.linearRampToValueAtTime(i===index?1:0,when+.012);});}
      this.emit();return when;
    }
    async take(index,quantise=1){
      this.ensure();const p=this.decks[index];
      if(!p?.ready)throw Error('Load this deck first.');
      if(p.paused||!p.voice)return this.launch(index,p.currentTime>=p.duration-.01?0:p.currentTime,'Play',{cut:true,quantise});
      this.cancel();const intent=this.intent;await this.context.resume();if(intent!==this.intent)return;
      const now=this.context.currentTime,grid=60/this.bpm*(quantise===4?4:1);
      const when=this.epoch+Math.ceil((now+.025-this.epoch)/grid)*grid;
      // A running standby deck keeps its place: only the mixer gains change.
      this.transition={index,from:this.fader,to:index,when};
      this.gains.forEach((g,i)=>{g.gain.setValueAtTime(i?this.fader:1-this.fader,when);g.gain.linearRampToValueAtTime(i===index?1:0,when+.012);});
      this.emit();return when;
    }
    pause(index){this.cancel();this.decks[index]?.pause();this.emit();}
    stop(){this.cancel();this.decks.forEach(p=>p.pause());this.epoch=null;this.emit();}
    async load(index,url,bpm,duration){
      this.ensure();this.cancel();this.decks[index].pause();
      await this.decks[index].load(url,bpm,duration);this.emit();
    }
  }
  globalThis.AfterhoursMixer=Mixer;
  if(typeof module!=='undefined'&&module.exports)module.exports=Mixer;
})();
