"""Loopback-only private studio with a durable library and one audio worker."""
import argparse
import copy
import json
import mimetypes
import math
import os
from pathlib import Path
import queue
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit, quote
import uuid

ROOT=Path(__file__).resolve().parent
os.environ['PATH']='/opt/homebrew/bin:/usr/local/bin:'+os.environ.get('PATH','')
import engine

DATA=Path(os.environ.get('REMIX_STUDIO_DATA',str(ROOT/'studio-data'))).resolve()
LIBRARY=DATA/'library.json'
LOCK=threading.RLock()
WORK=queue.Queue()
TOKEN=secrets.token_urlsafe(32)
STATE={'tracks':{},'jobs':{}}
EXTENSIONS={'.wav','.mp3','.flac','.m4a','.aiff','.aif','.ogg'}
ID=re.compile(r'^[a-f0-9]{32}$')
PROCESS=None
STOPPING=threading.Event()
PREPARE_LOCK=threading.Lock()

def set_bpm(value):
    if isinstance(value,bool): raise ValueError('Choose a BPM from 70 to 180.')
    value=float(value)
    if not math.isfinite(value) or not 70<=value<=180: raise ValueError('Choose a BPM from 70 to 180.')
    return round(value,1)

def prepare_deck(jid,bpm):
    bpm=set_bpm(bpm)
    with LOCK:
        if not isinstance(jid,str) or jid not in STATE['jobs'] or STATE['jobs'][jid]['status']!='done':
            raise ValueError('Choose a finished remix.')
        job=copy.deepcopy(STATE['jobs'][jid])
    result=job['result']; source_bpm=float(result['bpm']); ratio=bpm/source_bpm
    duration=result['duration']/ratio
    name='remix.wav'
    if abs(ratio-1)>.000001:
        name=f'set-{bpm:.1f}.wav'
        folder=DATA/'jobs'/jid; dest=folder/name
        # Serialize preparation separately from the library lock and rendering worker.
        # Playback/file serving remains available while this local copy is made.
        with PREPARE_LOCK:
            if not dest.exists():
                temp=folder/(name+'.partial.wav')
                try:
                    subprocess.run(['ffmpeg','-v','error','-y','-threads','1','-i',str(folder/'remix.wav'),
                        '-af',f'rubberband=tempo={ratio}:pitch=1:channels=together,apad,atrim=duration={duration},alimiter=limit=0.891:level=false:latency=true',
                        '-c:a','pcm_s24le',str(temp)],check=True,capture_output=True,timeout=240)
                    temp.replace(dest)
                finally:
                    if temp.exists(): temp.unlink()
    sections=[dict(s,start=s['start']/ratio,end=s['end']/ratio) for s in result.get('sections',[])]
    return {'url':f'/media/jobs/{jid}/{name}','bpm':bpm,'source_bpm':source_bpm,'duration':duration,'sections':sections}

def save():
    # Caller owns LOCK. Replace atomically so an interrupted write cannot erase the library.
    temp=LIBRARY.with_suffix('.tmp')
    temp.write_text(json.dumps(STATE,indent=2))
    temp.replace(LIBRARY)

def update(collection,key,**values):
    with LOCK:
        STATE[collection][key].update(values)
        save()

def public_state():
    with LOCK:
        tracks=[]; jobs=[]
        for t in STATE['tracks'].values():
            item={k:v for k,v in t.items() if k!='source'}
            item['audio_url']='/media/tracks/'+t['id']+'/original'
            tracks.append(item)
        for j in STATE['jobs'].values():
            item={k:v for k,v in j.items() if k!='out'}
            if j['status']=='done':
                item['audio_url']='/media/jobs/'+j['id']+'/remix.mp3'
                item['wav_url']=item['audio_url'].replace('remix.mp3','remix.wav')+'?download=1'
                item['mp3_url']=item['audio_url']+'?download=1'
                item['preview_url']=item['audio_url'].replace('remix.mp3','preview.mp3')
            jobs.append(item)
        return {'tracks':sorted(tracks,key=lambda t:t['created'],reverse=True),
                'jobs':sorted(jobs,key=lambda j:j['created'],reverse=True),
                'setlist':copy.deepcopy(STATE.get('setlist',{'bpm':136,'ids':[]}))}

def worker():
    global PROCESS
    while not STOPPING.is_set():
        try: kind,key=WORK.get(timeout=.5)
        except queue.Empty: continue
        collection='tracks' if kind=='analysis' else 'jobs'
        try:
            with LOCK: item=copy.deepcopy(STATE[collection][key])
            folder=DATA/('tracks' if kind=='analysis' else 'jobs')/key
            folder.mkdir(parents=True,exist_ok=True)
            request={'kind':kind,'result':str(folder/'result.json')}
            if kind=='analysis':
                request['source']=item['source']
                update(collection,key,status='analysing',message='Finding the rhythm and reading your track')
            else:
                with LOCK: track=copy.deepcopy(STATE['tracks'][item['track_id']])
                request.update(source=track['source'],analysis=track['analysis'],settings=item['settings'],out=str(folder))
                update(collection,key,status='running',progress=2,message='Getting your track ready')
            (folder/'request.json').write_text(json.dumps(request))
            with (folder/'worker.log').open('w') as log:
                PROCESS=subprocess.Popen([sys.executable,str(ROOT/'engine.py'),str(folder/'request.json')],
                    stdout=subprocess.PIPE,stderr=log,text=True,bufsize=1)
                error=None
                for line in PROCESS.stdout:
                    try: event=json.loads(line)
                    except ValueError: continue
                    if 'error' in event: error=event['error']
                    if 'progress' in event:
                        update(collection,key,progress=event['progress'],message=event['message'])
                code=PROCESS.wait()
                PROCESS=None
            if code: raise RuntimeError(error or 'The audio process stopped. Please try another variation.')
            result=json.loads((folder/'result.json').read_text())
            update(collection,key,status='ready' if kind=='analysis' else 'done',
                   **({'analysis':result} if kind=='analysis' else {'result':result}),
                   progress=100,message='Ready to listen')
        except Exception as exc:
            update(collection,key,status='error',message=str(exc),progress=0)
        finally: WORK.task_done()

def initialise(seed=True):
    global STATE
    DATA.mkdir(parents=True,exist_ok=True)
    (DATA/'tracks').mkdir(exist_ok=True); (DATA/'jobs').mkdir(exist_ok=True)
    if LIBRARY.exists():
        # Preserve an unreadable library and stop rather than replacing user history.
        STATE=json.loads(LIBRARY.read_text())
        if not all(isinstance(STATE.get(k),dict) for k in ('tracks','jobs')):
            raise RuntimeError('The library could not be read. Its file has been preserved.')
    for collection in ('tracks','jobs'):
        for item in STATE[collection].values():
            if item['status'] in ('queued','running','analysing'):
                item.update(status='error',progress=0,message='The app stopped before this finished. Try again.')
    if seed and not STATE['tracks']:
        source=Path('/Users/jamesburgess/Music/Lee Tones/Voyager Folk.mp3')
        approved=ROOT.parent/'structural-v1'
        if source.exists():
            tid=uuid.uuid4().hex; folder=DATA/'tracks'/tid; folder.mkdir()
            local=folder/'original.mp3'; shutil.copy2(source,local)
            analysis=engine.analyse(local)
            # This source had a more detailed phrase-timing check in the approved session.
            analysis.update(bpm=136.0,phase=.24566,confidence='steady')
            STATE['tracks'][tid]={'id':tid,'name':source.stem,'filename':source.name,'source':str(local),
                'created':time.time(),'status':'ready','analysis':analysis,'message':'Ready to remix'}
            wav=approved/'Voyager-Folk-Structural-Remix-v1.wav'
            if wav.exists():
                jid=uuid.uuid4().hex; dest=DATA/'jobs'/jid; dest.mkdir()
                shutil.copy2(wav,dest/'remix.wav')
                shutil.copy2(approved/'Voyager-Folk-Structural-Remix-v1.mp3',dest/'remix.mp3')
                shutil.copy2(approved/'Voyager-Folk-Breakdown-and-Return.mp3',dest/'preview.mp3')
                old=json.loads((approved/'remix-details.json').read_text())
                result={'duration':old['validation'][wav.name]['duration_s'],'bpm':136,
                    'loudness':old['validation'][wav.name]['input_i'],
                    'waveform':engine.waveform(engine.mono(dest/'remix.mp3')),
                    'sections':[{'name':s['name'],'start':s['start_s'],'end':s['end_s']} for s in old['sections']]}
                STATE['jobs'][jid]={'id':jid,'track_id':tid,'name':'The one you liked','status':'done',
                    'favorite':True,'created':time.time(),'settings':engine.options({}),
                    'result':result,'message':'Your approved first remix','progress':100,'out':str(dest),'approved':True}
    for track in STATE['tracks'].values():
        if track['status']=='ready' and Path(track['source']).exists():
            engine.listening_copy(track['source'],track['analysis'])
    with LOCK: save()

class Handler(BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'
    def log_message(self,fmt,*args):
        if '/api/state' not in (args[0] if args else ''): super().log_message(fmt,*args)
    def headers_common(self):
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Referrer-Policy','no-referrer')
        self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
    def reply(self,status,payload):
        data=json.dumps(payload).encode()
        self.send_response(status); self.headers_common()
        self.send_header('Content-Type','application/json'); self.send_header('Cache-Control','no-store')
        self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
    def trusted(self,mutation=False):
        port=self.server.server_port
        hosts={f'127.0.0.1:{port}',f'localhost:{port}'}
        if self.headers.get('Host') not in hosts:
            self.close_connection=True; self.reply(403,{'error':'Local access only.'}); return False
        if mutation:
            origin=self.headers.get('Origin')
            if origin and origin not in {'http://'+h for h in hosts}:
                self.close_connection=True; self.reply(403,{'error':'This request must come from the studio.'}); return False
            if not secrets.compare_digest(self.headers.get('X-Studio-Token',''),TOKEN):
                self.close_connection=True; self.reply(403,{'error':'Refresh the studio and try again.'}); return False
        return True
    def body(self,limit=16384):
        try: length=int(self.headers.get('Content-Length','-1'))
        except ValueError: length=-1
        if length<0 or length>limit: raise ValueError('Invalid request size.')
        return self.rfile.read(length)
    def do_GET(self):
        if not self.trusted(): return
        route=urlsplit(self.path); path=route.path
        if path=='/api/config': return self.reply(200,{'token':TOKEN,'max_upload_mb':200,'version':'1.0'})
        if path=='/api/state': return self.reply(200,public_state())
        static={'/':'index.html','/app.js':'app.js','/beat-player.js':'beat-player.js','/mixer.js':'mixer.js','/performance.js':'performance.js','/style.css':'style.css','/favicon.svg':'favicon.svg'}
        if path in static: return self.file(ROOT/'web'/static[path])
        parts=path.strip('/').split('/')
        if len(parts)==4 and parts[0]=='media' and ID.fullmatch(parts[2]):
            collection,key,name=parts[1:]
            media_path=None; download=None
            with LOCK:
                if collection=='tracks' and key in STATE['tracks'] and name=='original':
                    original=Path(STATE['tracks'][key]['source'])
                    preview=original.parent/'listen.mp3'
                    media_path=preview if preview.exists() else original
                if collection=='jobs' and key in STATE['jobs'] and STATE['jobs'][key]['status']=='done' and name in ('remix.mp3','remix.wav','preview.mp3'):
                    title=STATE['jobs'][key]['name']
                    media_path=DATA/'jobs'/key/name
                    download=title+Path(name).suffix if 'download' in parse_qs(route.query) else None
                if collection=='jobs' and key in STATE['jobs'] and STATE['jobs'][key]['status']=='done' and re.fullmatch(r'set-\d{2,3}\.\d\.wav',name):
                    media_path=DATA/'jobs'/key/name
                    download=STATE['jobs'][key]['name']+'-'+name if 'download' in parse_qs(route.query) else None
            if media_path: return self.file(media_path,download)
        self.reply(404,{'error':'Not found.'})
    def do_POST(self):
        if not self.trusted(True): return
        route=urlsplit(self.path)
        try:
            if route.path=='/api/tracks': return self.upload(route)
            data=json.loads(self.body())
            if not isinstance(data,dict): raise ValueError('Invalid request.')
            if route.path=='/api/prepare-deck':
                return self.reply(200,prepare_deck(data.get('id'),data.get('bpm')))
            if route.path=='/api/setlist':
                bpm=set_bpm(data.get('bpm')); ids=data.get('ids')
                if not isinstance(ids,list) or len(ids)>200 or any(not isinstance(i,str) for i in ids) or len(set(ids))!=len(ids):
                    raise ValueError('Choose up to 200 distinct remixes for your crate.')
                with LOCK:
                    if any(i not in STATE['jobs'] or STATE['jobs'][i]['status']!='done' for i in ids):
                        raise ValueError('Only finished remixes can go in the crate.')
                    STATE['setlist']={'bpm':bpm,'ids':ids}; save()
                return self.reply(200,{'ok':True})
            if route.path=='/api/jobs':
                tid=data.get('track_id')
                settings=engine.options(data.get('settings',{}))
                with LOCK:
                    if tid not in STATE['tracks'] or STATE['tracks'][tid]['status']!='ready':
                        raise ValueError('Choose a track that has finished analysing.')
                    if sum(j['status'] in ('running','queued') for j in STATE['jobs'].values())>=3:
                        raise ValueError('Three versions are already waiting. Let one finish first.')
                    jid=uuid.uuid4().hex
                    label={'broken':'Broken beat','techno':'Minimal techno','halftime':'Half-time'}[settings['style']]
                    number=1+sum(j['track_id']==tid for j in STATE['jobs'].values())
                    STATE['jobs'][jid]={'id':jid,'track_id':tid,'name':label+' · '+str(number),
                        'created':time.time(),'status':'queued','progress':0,'message':'Waiting for the audio worker',
                        'favorite':False,'settings':settings,'out':str(DATA/'jobs'/jid)}
                    save()
                WORK.put(('render',jid)); return self.reply(202,{'id':jid})
            match=re.fullmatch(r'/api/jobs/([a-f0-9]{32})/favorite',route.path)
            if match:
                if not isinstance(data.get('favorite'),bool): raise ValueError('Invalid favorite choice.')
                with LOCK:
                    if match[1] not in STATE['jobs']: return self.reply(404,{'error':'Version not found.'})
                    update('jobs',match[1],favorite=data['favorite'])
                return self.reply(200,{'ok':True})
            match=re.fullmatch(r'/api/tracks/([a-f0-9]{32})/retry',route.path)
            if match:
                with LOCK:
                    if match[1] not in STATE['tracks'] or STATE['tracks'][match[1]]['status']!='error': raise ValueError('This track does not need a retry.')
                    update('tracks',match[1],status='queued',message='Waiting to analyse')
                WORK.put(('analysis',match[1])); return self.reply(202,{'ok':True})
            self.reply(404,{'error':'Not found.'})
        except (ValueError,TypeError,KeyError,OverflowError) as exc:
            self.close_connection=True; self.reply(400,{'error':str(exc)})
        except Exception:
            self.close_connection=True; self.reply(500,{'error':'The request could not be saved. Your existing versions are safe.'})
    def upload(self,route):
        params=parse_qs(route.query); filename=Path(params.get('name',['track'])[0]).name[:180]
        ext=Path(filename).suffix.lower()
        if ext not in EXTENSIONS: raise ValueError('Choose WAV, MP3, FLAC, M4A, AIFF or OGG audio.')
        try: length=int(self.headers.get('Content-Length','-1'))
        except ValueError: length=-1
        if length<=0 or length>200*1024*1024: raise ValueError('Choose a file smaller than 200 MB.')
        with LOCK:
            if sum(t['status'] in ('queued','analysing') for t in STATE['tracks'].values())>=3:
                raise ValueError('Let the current tracks finish analysing before adding more.')
        tid=uuid.uuid4().hex; folder=DATA/'tracks'/tid; folder.mkdir()
        dest=folder/('original'+ext)
        remaining=length
        with dest.open('xb') as f:
            while remaining:
                chunk=self.rfile.read(min(1024*1024,remaining))
                if not chunk: raise ValueError('The upload was interrupted. Please try again.')
                f.write(chunk); remaining-=len(chunk)
        with LOCK:
            STATE['tracks'][tid]={'id':tid,'name':Path(filename).stem,'filename':filename,'source':str(dest),
                'created':time.time(),'status':'queued','message':'Waiting to analyse'}
            save()
        WORK.put(('analysis',tid)); self.reply(201,{'id':tid})
    def file(self,path,download=None):
        if not path.is_file(): return self.reply(404,{'error':'File not found.'})
        size=path.stat().st_size; start=0; end=size-1; status=200
        r=self.headers.get('Range')
        if r:
            match=re.fullmatch(r'bytes=(\d*)-(\d*)',r)
            if not match or not any(match.groups()): return self.reply(416,{'error':'Invalid range.'})
            if match[1]: start=int(match[1]); end=min(int(match[2]) if match[2] else end,end)
            else: start=max(0,size-int(match[2]))
            if start>end or start>=size: return self.reply(416,{'error':'Invalid range.'})
            status=206
        self.send_response(status); self.headers_common()
        self.send_header('Content-Type',mimetypes.guess_type(str(path))[0] or 'application/octet-stream')
        self.send_header('Accept-Ranges','bytes'); self.send_header('Content-Length',str(end-start+1))
        self.send_header('Cache-Control','no-store' if path.suffix in ('.html','.js','.css') else 'private, max-age=3600')
        if status==206: self.send_header('Content-Range',f'bytes {start}-{end}/{size}')
        if download: self.send_header('Content-Disposition',"attachment; filename*=UTF-8''"+quote(download,safe=''))
        self.end_headers()
        try:
            with path.open('rb') as f:
                f.seek(start); remaining=end-start+1
                while remaining:
                    block=f.read(min(65536,remaining))
                    if not block: break
                    self.wfile.write(block); remaining-=len(block)
        except (BrokenPipeError,ConnectionResetError): pass

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--port',type=int,default=8769)
    parser.add_argument('--open',action='store_true'); parser.add_argument('--no-seed',action='store_true')
    args=parser.parse_args()
    for binary in ('ffmpeg','ffprobe'):
        if not shutil.which(binary): raise SystemExit('This app needs '+binary+' installed on this Mac.')
    try: server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
    except OSError as exc:
        if args.open:
            import urllib.request
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{args.port}/api/config',timeout=2) as r:
                    existing=json.load(r)
                if existing.get('version')=='1.0':
                    import webbrowser
                    webbrowser.open(f'http://127.0.0.1:{args.port}'); return
            except Exception: pass
        raise SystemExit(f'Could not start the studio on port {args.port}: {exc}')
    initialise(not args.no_seed)
    threading.Thread(target=worker,daemon=True).start()
    url=f'http://127.0.0.1:{server.server_port}'
    print('Private remix studio: '+url,flush=True)
    if args.open:
        import webbrowser
        webbrowser.open(url)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally:
        STOPPING.set()
        if PROCESS is not None: PROCESS.terminate()
        server.server_close()

if __name__=='__main__': main()
