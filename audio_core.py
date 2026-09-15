"""Audio helpers retained from the user-approved structural remix."""
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import numpy as np

SR = 44100
BPM = 136.0
BEAT = 60 / BPM
BAR = 4 * BEAT
PHASE = 0.24566
RNG = np.random.default_rng(8107)

def command(args, data=None):
    p = subprocess.run(args, input=data, capture_output=True)
    if p.returncode:
        raise RuntimeError(p.stderr.decode(errors='replace')[-4000:])
    return p

def decode(path):
    raw = command(['ffmpeg','-v','error','-i',str(path),'-ac','2','-ar',str(SR),'-f','f32le','-']).stdout
    return np.frombuffer(raw, dtype='<f4').reshape(-1, 2).copy()

def fx(x, filters):
    raw = command(['ffmpeg','-v','error','-f','f32le','-ar',str(SR),'-ac','2','-i','pipe:0',
                   '-af',filters,'-f','f32le','pipe:1'], np.asarray(x,dtype='<f4').tobytes()).stdout
    return np.frombuffer(raw,dtype='<f4').reshape(-1,2).copy()

def fade(x, seconds=.008):
    y = x.copy()
    n = min(round(seconds*SR), len(y)//2)
    if n:
        ramp = np.sin(np.linspace(0,np.pi/2,n))**2
        y[:n] *= ramp[:,None]
        y[-n:] *= ramp[::-1,None]
    return y

def hpss(x):
    n, hop = 4096, 512
    padded = np.pad(x, ((n//2,n), (0,0)))
    frames = np.lib.stride_tricks.sliding_window_view(padded,n,axis=0)[::hop]
    win = np.hanning(n)
    spectrum = np.fft.rfft(frames*win[None,None,:],axis=-1).astype(np.complex64)
    mag = np.abs(spectrum).mean(axis=1)
    time_pad = np.pad(mag, ((15,15),(0,0)), mode='edge')
    time_frames = np.lib.stride_tricks.sliding_window_view(time_pad,31,axis=0)
    harmonic = np.empty_like(mag)
    percussive = np.empty_like(mag)
    for a in range(0,len(mag),64):
        b = min(a+64,len(mag))
        harmonic[a:b] = np.median(time_frames[a:b],axis=-1)
        freq_frames = np.lib.stride_tricks.sliding_window_view(np.pad(mag[a:b],((0,0),(15,15)),mode='edge'),31,axis=1)
        percussive[a:b] = np.median(freq_frames,axis=-1)
    mask = harmonic**2 / (harmonic**2 + (1.6*percussive)**2 + 1e-12)
    def inverse(s):
        y = np.zeros((len(padded),2),dtype=np.float64)
        weights = np.zeros(len(padded))
        blocks = np.fft.irfft(s,n=n,axis=-1)*win[None,None,:]
        for i,block in enumerate(blocks):
            start=i*hop
            y[start:start+n] += block.T
            weights[start:start+n] += win**2
        y /= np.maximum(weights,1e-10)[:,None]
        return y[n//2:n//2+len(x)].astype(np.float32)
    recovered = inverse(spectrum)
    reconstruction_error = float(np.max(np.abs(recovered-x)))
    assert reconstruction_error < 1e-5, reconstruction_error
    h = inverse(spectrum*mask[:,None,:])
    return h, x-h, reconstruction_error

def hit_kick():
    t=np.arange(round(.48*SR))/SR
    freq=48+112*np.exp(-t/.025)
    phase=2*np.pi*np.cumsum(freq)/SR
    body=np.sin(phase)*np.exp(-t/.115)*(1-np.exp(-t/.001))
    click=RNG.normal(0,1,len(t))*np.exp(-t/.003)*.10
    y=np.tanh((body+click)*1.4)/1.4
    return fade(np.repeat(y[:,None],2,axis=1),.001)

def hit_snare():
    t=np.arange(round(.21*SR))/SR
    noise=RNG.normal(0,1,(len(t),2))
    noise=fx(noise,'highpass=f=1300,lowpass=f=10500')
    env=np.exp(-t/.040)+.55*np.exp(-np.maximum(t-.013,0)/.025)*(t>.013)
    body=np.sin(2*np.pi*185*t)*np.exp(-t/.035)
    return fade(noise*env[:,None]*.16+body[:,None]*.15,.001)

def hit_hat(opened=False):
    duration=.20 if opened else .07
    t=np.arange(round(duration*SR))/SR
    noise=fx(RNG.normal(0,1,(len(t),2)),'highpass=f=6700,lowpass=f=15000')
    metallic=sum(np.sin(2*np.pi*f*t) for f in [7207,9311,11003])/3
    env=np.exp(-t/(.047 if opened else .013))
    return fade((noise*.09+metallic[:,None]*.018)*env[:,None],.0008)

def add(dst, src, at, gain=1):
    a=round(at*SR)
    if a>=len(dst): return
    b=min(a+len(src),len(dst))
    dst[a:b] += src[:b-a]*gain

def section_for(bar):
    if bar<8: return 'intro'
    if bar<24: return 'groove'
    if bar<32: return 'breakdown'
    if bar<36: return 'build'
    if bar<52: return 'main_return'
    if bar<60: return 'late_variation'
    return 'outro'

def measured(path):
    p=command(['ffmpeg','-hide_banner','-nostats','-i',str(path),'-af',
               'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json','-f','null','-'])
    d=json.loads(re.findall(r'\{[^{}]*"input_i"[^{}]*\}',p.stderr.decode())[-1])
    return {k:float(d[k]) for k in ['input_i','input_tp','input_lra']}

def write_wav(path,x,float_audio=False):
    command(['ffmpeg','-v','error','-n','-f','f32le','-ar',str(SR),'-ac','2','-i','pipe:0',
             '-c:a','pcm_f32le' if float_audio else 'pcm_s24le',str(path)],
             np.asarray(x,dtype='<f4').tobytes())
