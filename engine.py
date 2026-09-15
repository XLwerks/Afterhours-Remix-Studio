"""Local audio engine. Reuses the source-processing work approved in this task."""
import json
import math
from pathlib import Path
import subprocess
import numpy as np

import audio_core as core
SR = 44100

def emit(progress, message):
    print(json.dumps({'progress': progress, 'message': message}), flush=True)

def probe(path):
    raw = core.command(['ffprobe','-v','error','-show_entries',
        'format=duration:stream=codec_type,sample_rate,channels','-of','json',str(path)])
    data = json.loads(raw.stdout)
    audio = [s for s in data.get('streams',[]) if s.get('codec_type') == 'audio']
    duration = float(data.get('format',{}).get('duration', 0))
    if not audio or not math.isfinite(duration) or not 30 <= duration <= 600:
        raise ValueError('Please choose an audio track between 30 seconds and 10 minutes long.')
    return duration

def mono(path, rate=11025):
    raw = core.command(['ffmpeg','-v','error','-i',str(path),'-vn','-ac','1',
                        '-ar',str(rate),'-f','f32le','-']).stdout
    return np.frombuffer(raw, dtype='<f4').copy()

def waveform(x, bins=400):
    if x.ndim == 2: x = np.abs(x).mean(axis=1)
    edges = np.linspace(0,len(x),bins+1,dtype=int)
    values = np.array([np.sqrt(np.mean(x[a:max(a+1,b)]**2)) for a,b in zip(edges[:-1],edges[1:])])
    peak = max(float(np.max(values)),1e-9)
    return np.round(values/peak,3).tolist()

def analyse(path):
    duration = probe(path)
    x = mono(path)
    if not np.isfinite(x).all() or np.sqrt(np.mean(x*x)) < 1e-5:
        raise ValueError('This file is silent or too quiet to find a usable phrase. Try a different export.')
    sr,n,hop = 11025,1024,110
    frames = np.lib.stride_tricks.sliding_window_view(x,n)[::hop]
    # Only the strongest four-minute region is needed for rhythm estimation.
    frames = frames[:round(240*sr/hop)]
    mag = np.abs(np.fft.rfft(frames*np.hanning(n),axis=1))
    freqs = np.fft.rfftfreq(n,1/sr)
    novelty = np.maximum(np.diff(np.log1p(mag[:,freqs>35]*10),axis=0),0).mean(axis=1)
    novelty -= novelty.mean()
    size = 1 << (2*len(novelty)-1).bit_length()
    fft = np.fft.rfft(novelty,n=size)
    ac = np.fft.irfft(fft*fft.conj(),n=size)[:len(novelty)]
    ac /= np.arange(len(ac),0,-1)
    ac /= max(float(ac[0]),1e-10)
    bpms = np.linspace(85,170,1701)
    rate = sr/hop
    scores = np.zeros_like(bpms)
    for beats,weight in [(1,.10),(2,.15),(4,.2),(8,.35),(16,.2)]:
        scores += weight*np.interp(60*beats*rate/bpms,np.arange(len(ac)),ac,left=0,right=0)
    index = int(np.argmax(scores))
    bpm = round(float(bpms[index]),1)
    # Snap a close estimate to an integer only when long phrase timing supports it.
    if abs(bpm-round(bpm)) < .2: bpm = float(round(bpm))
    beat = 60/bpm
    times = (np.arange(len(novelty))*hop+n/2)/sr
    low = np.maximum(np.diff(np.log1p(mag[:,(freqs>35)&(freqs<140)]*10),axis=0),0).mean(axis=1)
    phases = np.linspace(0,beat,221,endpoint=False)
    phase_scores = []
    for phase in phases:
        distance = np.abs((times-phase+beat/2)%beat-beat/2)
        phase_scores.append(float(np.sum(low*np.exp(-.5*(distance/.020)**2))))
    phase = float(phases[np.argmax(phase_scores)])
    loudness = core.measured(path)
    return {'duration': duration,'bpm': bpm,'phase': phase,
            'confidence': 'steady' if scores[index] > .20 else 'uncertain',
            'loudness': loudness['input_i'],'true_peak': loudness['input_tp'],
            'waveform': waveform(x)}

def options(raw):
    if not isinstance(raw,dict): raise ValueError('Settings must be an object.')
    out = {}
    for key,default in [('change',75),('melody',60),('drums',55)]:
        value = raw.get(key,default)
        if isinstance(value,bool): raise ValueError('Invalid '+key)
        value = float(value)
        if not math.isfinite(value) or not 0 <= value <= 100: raise ValueError('Invalid '+key)
        out[key] = value
    for key,allowed,default in [('style',('broken','techno','halftime'),'broken'),
                               ('length',('short','standard','extended'),'standard'),
                               ('breakdown',('short','roomy','long'),'roomy')]:
        value = raw.get(key,default)
        if value not in allowed: raise ValueError('Invalid '+key)
        out[key] = value
    bpm = raw.get('bpm')
    if bpm not in (None,''):
        bpm = float(bpm)
        if not math.isfinite(bpm) or not 70 <= bpm <= 180: raise ValueError('Tempo must be between 70 and 180.')
    else: bpm = None
    out['bpm'] = bpm
    seed = int(raw.get('seed',8107))
    if not 0 <= seed <= 2**32-1: raise ValueError('Invalid variation.')
    out['seed'] = seed
    return out

def listening_copy(path, analysis):
    """Browser-compatible reference with fixed gain, preserving the uploaded original."""
    path=Path(path)
    gain=min(0,-16-analysis['loudness'],-2-analysis['true_peak'])
    target=path.parent/'listen.mp3'
    if not target.exists():
        core.command(['ffmpeg','-v','error','-n','-i',str(path),'-vn','-af',f'volume={gain}dB',
                      '-c:a','libmp3lame','-b:a','320k',str(target)])
    analysis['listening_loudness']=analysis['loudness']+gain
    return analysis

def arrangement(settings, beat):
    scale = settings['length']
    intro,groove,main,late,outro = {'short':(4,8,8,4,4),
        'standard':(8,16,16,8,4),'extended':(16,24,24,16,8)}[scale]
    breakdown = {'short':4,'roomy':8,'long':16}[settings['breakdown']]
    build = 4
    sections=[]; start=0
    for key,label,bars in [('intro','Opening',intro),('groove','New groove',groove),
        ('breakdown','Breakdown',breakdown),('build','Build',build),
        ('main','Main return',main),('late','Variation',late),('outro','Outro',outro)]:
        sections.append({'key':key,'name':label,'bar':start,'bars':bars,
                         'start':round(start*4*beat,3),'end':round((start+bars)*4*beat,3)})
        start += bars
    return sections,start

def source_starts(info, beat, seed):
    span=32*beat
    latest=info['duration']-span-.05
    if latest < 0: raise ValueError('This track is too short for eight-bar phrases at this tempo.')
    rng=np.random.default_rng(seed)
    starts=[]
    for proportion in [.35,.55]:
        guess=info['duration']*proportion+float(rng.uniform(-1,1))*4*beat
        index=max(0,round((guess-info['phase'])/(4*beat)))
        start=info['phase']+index*4*beat
        if start>latest:
            start=info['phase']+max(0,math.floor((latest-info['phase'])/(4*beat)))*4*beat
        starts.append(max(0,min(start,latest)))
    return starts

def read_excerpt(path,start,duration):
    raw=core.command(['ffmpeg','-v','error','-ss',str(start),'-i',str(path),'-t',str(duration),
                      '-vn','-ac','2','-ar',str(SR),'-f','f32le','-']).stdout
    return np.frombuffer(raw,dtype='<f4').reshape(-1,2).copy()

def render(path, info, settings, out):
    settings=options(settings)
    out=Path(out); out.mkdir(parents=True,exist_ok=True)
    beat=60/(settings['bpm'] or info['bpm']); bar_seconds=4*beat
    core.RNG=np.random.default_rng(settings['seed'])
    rng=np.random.default_rng(settings['seed'])
    sections,total_bars=arrangement(settings,beat)
    starts=source_starts(info,beat,settings['seed'])
    emit(8,'Finding phrases in your track')
    loops=[]
    input_gain=10**(min(-8,-18-info['loudness'])/20)
    for i,start in enumerate(starts):
        x=read_excerpt(path,start,32*beat)*input_gain
        required=round(32*beat*SR)
        if len(x)<required: x=np.pad(x,((0,required-len(x)),(0,0)))
        h,p,error=core.hpss(x)
        bass=core.fx(h,'highpass=f=30,lowpass=f=155')
        bass[:]=bass.mean(axis=1,keepdims=True)
        loops.append({'mid':core.fx(h,'highpass=f=170,lowpass=f=9000'),'bass':bass,
            'air':core.fx(h,'highpass=f=350,lowpass=f=3300'),
            'texture':core.fx(p,'highpass=f=2200,lowpass=f=12000')})
        emit(25+i*20,'Reshaping the sounds in your track')
    count=round(total_bars*bar_seconds*SR)
    music=np.zeros((count,2),np.float32); bassline=np.zeros_like(music)
    air=np.zeros_like(music); drums=np.zeros_like(music); duck=np.ones(count,np.float32)
    kick,snare,hat,ohat=core.hit_kick(),core.hit_snare(),core.hit_hat(),core.hit_hat(True)
    change=settings['change']/100; melody=settings['melody']/100; density=settings['drums']/100
    melodic_gain=.2+melody*1.4
    def fragment(arr,index):
        a=round(index%8*bar_seconds*SR); b=round((index%8+1)*bar_seconds*SR)
        return core.fade(arr[a:b])
    phrase_order=[0,0,2,1,0,3,2,7]
    # Seed changes phrasing as well as the drum accents.
    offset=int(rng.integers(0,4))*2
    for sec in sections:
        key=sec['key']
        loop=loops[1 if key in ('main','late','outro') else 0]
        for local in range(sec['bars']):
            bar=sec['bar']+local; pos=bar*bar_seconds
            source=(phrase_order[local%8]+offset)%8 if change>.35 else local%8
            m,b,a,p=[fragment(loop[k],source) for k in ('mid','bass','air','texture')]
            if key=='intro':
                m=core.fx(m,f'lowpass=f={1100+local*350}')
                if local%2==0: core.add(music,m[:round(.7*beat*SR)],pos+.75*beat,.72*melodic_gain)
                if local>=sec['bars']//2: core.add(bassline,b,pos,.7)
                core.add(air,a[::-1].copy(),pos,.25)
            elif key in ('groove','main','late'):
                pattern=[(0,0),(.75,1.5),(1.5,.5),(2.5,2),(3.25,3)]
                if local%4==3: pattern=[(0,2),(1,0),(1.75,3),(2.5,1),(3.5,3)]
                if key=='late' or density<.25: pattern=[(0,0),(1.5,2),(3,1)]
                # At low change, blend longer original phrases; high change uses only chops.
                continuous=max(0,1-change*1.55)
                core.add(music,m,pos,continuous*melodic_gain)
                for dest,src in pattern:
                    start=round(src*beat*SR); end=round((src+.48)*beat*SR)
                    frag=core.fade(m[start:end],.009)
                    gain=(1.2 if key=='main' else 1.05)*melodic_gain*(1-continuous*.65)
                    core.add(music,frag,pos+dest*beat,gain)
                    core.add(music,frag[:,::-1].copy(),pos+(dest+.75)*beat,gain*.20)
                    core.add(music,frag,pos+(dest+1.5)*beat,gain*.07)
                core.add(bassline,b,pos,1.3 if key=='main' else 1.05)
                core.add(music,p,pos,.08+.2*density)
            elif key=='breakdown':
                core.add(air,a,pos,1.15*melodic_gain)
                core.add(air,a[:,::-1].copy(),pos+.75*beat,.32*melodic_gain)
                if local>=sec['bars']//2: core.add(air,a[::-1].copy(),pos,.38*melodic_gain)
            elif key=='build':
                frag=core.fade(m[:round(.45*beat*SR)])
                for k in np.arange(0,4,.5 if local<2 else .25):
                    core.add(music,frag,pos+k*beat,(.35+.12*local)*melodic_gain)
                    core.add(drums,snare,pos+k*beat,(.13+.06*local)*(.5+density))
                core.add(air,a,pos,.5*melodic_gain)
            else:
                core.add(air,a,pos,.55*(sec['bars']-local)/sec['bars']*melodic_gain)
                if local<sec['bars']//2: core.add(bassline,b,pos,.6)
            if key in ('groove','main','late') or (key=='intro' and local>=sec['bars']//2):
                if settings['style']=='techno': kicks=[0,1,2,3]; snares=[1,3]
                elif settings['style']=='halftime': kicks=[0,2.75] if local%2==0 else [0,.75,3.5]; snares=[2]
                else: kicks=[0,1.5,2.75] if local%2==0 else [0,.75,2.5,3.5]; snares=[1,3]
                if density<.3 and settings['style']!='techno': kicks=kicks[:2]
                if key=='intro': kicks=[0,2.5]
                if key=='late' and settings['style']!='techno': kicks=[0,2.75]
                for k in kicks:
                    core.add(drums,kick,pos+k*beat,.60 if key=='main' else .53)
                    start=round((pos+k*beat)*SR); n=min(round(.21*SR),count-start)
                    duck[start:start+n]=np.minimum(duck[start:start+n],1-.58*np.exp(-np.arange(n)/SR/.065))
                for k in snares: core.add(drums,snare,pos+k*beat,.7 if key=='main' else .6)
                step=.25 if density>.78 else (1 if density<.3 else .5)
                for k in np.arange(.5,4,step):
                    swing=.022 if settings['style']!='techno' and round(k*4)%2 else 0
                    core.add(drums,ohat if k in (1.5,3.5) else hat,pos+k*beat+swing,.5+float(rng.uniform(-.1,.1)))
    emit(66,'Building the breakdown and return')
    breakdown=next(s for s in sections if s['key']=='breakdown')
    start=round(breakdown['bar']*bar_seconds*SR); end=round((breakdown['bar']+breakdown['bars'])*bar_seconds*SR)
    n=round(.02*SR); drums[start-n:start]*=np.linspace(1,0,n)[:,None]; drums[start:end]=0
    main=next(s for s in sections if s['key']=='main')
    drop=round(main['bar']*bar_seconds*SR); cut=drop-round(.5*beat*SR)
    for layer in (music,bassline,air,drums):
        layer[cut-n:cut]*=np.linspace(1,0,n)[:,None]; layer[cut:drop]=0
    noise=core.fx(rng.normal(0,1,(round(.9*SR),2)),'highpass=f=5500,lowpass=f=13000')
    noise*=np.exp(-np.arange(len(noise))/SR/.18)[:,None]*.07
    core.add(drums,core.fade(noise,.003),drop/SR)
    music*=duck[:,None]; bassline*=duck[:,None]
    mixed=music+bassline+air+drums
    mixed[:round(.12*SR)]*=np.linspace(0,1,round(.12*SR))[:,None]
    mixed[-round(3*SR):]*=np.linspace(1,0,round(3*SR))[:,None]
    if not np.isfinite(mixed).all(): raise ValueError('The audio could not be rendered. Try another variation.')
    raw=out/'working.wav'; core.write_wav(raw,mixed,True)
    pre=core.measured(raw); gain=min(-16-pre['input_i'],-2-pre['input_tp'])
    final=mixed*10**(gain/20)
    emit(80,'Preparing your WAV and MP3')
    wav=out/'remix.wav'; mp3=out/'remix.mp3'; core.write_wav(wav,final)
    core.command(['ffmpeg','-v','error','-n','-i',str(wav),'-c:a','libmp3lame','-b:a','320k',str(mp3)])
    preview_start=max(0,main['bar']*bar_seconds-8*beat)
    preview_duration=min(32*beat,len(final)/SR-preview_start)
    core.command(['ffmpeg','-v','error','-n','-ss',str(preview_start),'-i',str(wav),'-t',str(preview_duration),
        '-af',f'afade=t=in:d=0.02,afade=t=out:st={max(0,preview_duration-.2)}:d=0.2',
        '-c:a','libmp3lame','-b:a','320k',str(out/'preview.mp3')])
    emit(93,'Checking the finished files')
    checks={}
    for file in (wav,mp3):
        m=core.measured(file)
        if m['input_tp'] > -.8: raise ValueError('Export peak check failed. Please try another variation.')
        checks[file.name]=m
    # This exact intermediate is generated by this job and no longer needed.
    raw.unlink()
    return {'duration':len(final)/SR,'bpm':60/beat,'sections':sections,'waveform':waveform(final),
        'loudness':checks['remix.mp3']['input_i'],'checks':checks,
        'source_starts':starts,'preview_start':preview_start,'settings':settings}

if __name__=='__main__':
    import sys
    request=json.loads(Path(sys.argv[1]).read_text())
    try:
        if request['kind']=='analysis': result=listening_copy(request['source'],analyse(request['source']))
        else: result=render(request['source'],request['analysis'],request['settings'],request['out'])
        Path(request['result']).write_text(json.dumps(result))
        emit(100,'Ready to listen')
    except Exception as exc:
        print(json.dumps({'error':str(exc)}),flush=True)
        raise
