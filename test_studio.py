"""End-to-end test in an isolated temporary library, with real audio rendering."""
import http.client
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import engine

ROOT=Path(__file__).resolve().parent
SOURCE=Path('/Users/jamesburgess/Music/Lee Tones/Voyager Folk.mp3')

def check(condition,message):
    if not condition: raise AssertionError(message)
    print('PASS '+message,flush=True)

def main():
    for field,value in [('change',float('nan')),('drums',101),('bpm',0),('style','unsupported'),('seed',-1)]:
        try: engine.options({field:value})
        except (ValueError,TypeError): pass
        else: raise AssertionError('Accepted invalid '+field)
    check(True,'Invalid audio settings rejected')
    sections,total=engine.arrangement(engine.options({'length':'short','breakdown':'short'}),60/136)
    check(total==36 and sections[2]['bars']==4,'Length and breakdown controls change the arrangement')
    longer,total2=engine.arrangement(engine.options({'length':'extended','breakdown':'long'}),60/136)
    check(total2>total and longer[2]['bars']==16,'Extended arrangement retains requested long breakdown')
    info={'duration':30,'phase':.3}
    check(all(0<=s<=30-32*60/70 for s in engine.source_starts(info,60/70,4)), 'Phrase selection stays inside a short source')
    temp=Path(tempfile.mkdtemp(prefix='afterhours-test-'))
    env={**os.environ,'REMIX_STUDIO_DATA':str(temp/'data'),'PYTHONDONTWRITEBYTECODE':'1'}
    process=None
    def start():
        p=subprocess.Popen([sys.executable,str(ROOT/'server.py'),'--port','0','--no-seed'],
            stdout=subprocess.PIPE,stderr=(temp/'server.log').open('a'),env=env,text=True)
        line=p.stdout.readline().strip()
        if not line.startswith('Private remix studio: '): raise RuntimeError(line or 'Server failed to start')
        return p,line.split(': ',1)[1]
    try:
        process,base=start()
        def request(path,data=None,token=None,headers=None,method=None):
            h=headers or {}
            if token is not None: h['X-Studio-Token']=token
            if isinstance(data,dict): data=json.dumps(data).encode();h['Content-Type']='application/json'
            req=urllib.request.Request(base+path,data=data,headers=h,method=method)
            try:
                with urllib.request.urlopen(req,timeout=20) as r:return r.status,dict(r.headers),r.read()
            except urllib.error.HTTPError as r:return r.code,dict(r.headers),r.read()
        def getstate(): return json.loads(request('/api/state')[2])
        token=json.loads(request('/api/config')[2])['token']
        check(getstate()=={'tracks':[],'jobs':[]},'Fresh library starts empty')
        check(request('/api/jobs',{},token='wrong')[0]==403,'Unauthorized writes rejected')
        check(request('/api/jobs',{},token=token,headers={'Origin':'https://example.com'})[0]==403,'Cross-site writes rejected')
        check(request('/api/state',headers={'Host':'example.com'})[0]==403,'Non-local Host rejected')
        check(request('/media/jobs/../../library.json')[0]==404,'File traversal rejected')
        check(request('/api/tracks?name=bad.exe',b'bad',token=token)[0]==400,'Unsupported file upload rejected')
        for resource in ['/','/app.js','/style.css','/favicon.svg']:
            code,h,body=request(resource)
            check(code==200 and len(body)>10 and 'Content-Security-Policy' in h,'Serves '+resource)
        code,h,body=request('/api/tracks?name=Voyager%20Folk.mp3',SOURCE.read_bytes(),token=token)
        check(code==201,'Uploads a real finished MP3')
        tid=json.loads(body)['id']
        deadline=time.time()+120
        while time.time()<deadline:
            tr=next(t for t in getstate()['tracks'] if t['id']==tid)
            if tr['status'] in ('ready','error'): break
            time.sleep(.5)
        check(tr['status']=='ready','Real-track analysis completes: '+tr.get('message',''))
        check(abs(tr['analysis']['bpm']-136)<1,'Automatic tempo matches the previously checked phrase timing')
        check(len(tr['analysis']['waveform'])==400,'Analysis supplies a real waveform')
        settings={'style':'techno','length':'short','breakdown':'short','change':95,'drums':85,'melody':40,'seed':312}
        code,h,body=request('/api/jobs',{'track_id':tid,'settings':settings},token=token)
        check(code==202,'Accepts a new minimal-techno remix job')
        jid=json.loads(body)['id']; deadline=time.time()+300; last=None
        while time.time()<deadline:
            j=next(j for j in getstate()['jobs'] if j['id']==jid)
            if j['message']!=last: print(j['status']+': '+j['message'],flush=True);last=j['message']
            if j['status'] in ('done','error'):break
            time.sleep(1)
        check(j['status']=='done','Real remix render completes: '+j.get('message',''))
        check(abs(j['result']['duration']-36*4*60/j['result']['bpm'])<.05,'Short remix has the requested number of bars')
        check(j['result']['settings']['style']=='techno','Renderer receives the selected drum direction')
        check(j['result']['checks']['remix.mp3']['input_tp'] < -.8,'Encoded MP3 peak check passes')
        code,h,body=request(j['audio_url'],headers={'Range':'bytes=0-1023'})
        check(code==206 and len(body)==1024 and h.get('Content-Range','').startswith('bytes 0-1023/'),'Audio range requests support seeking')
        code,h,body=request(j['wav_url'])
        check(code==200 and body[:4]==b'RIFF' and 'attachment' in h.get('Content-Disposition',''),'WAV download returns an actual audio file')
        code,h,body=request(j['mp3_url'])
        check(code==200 and len(body)>100000 and 'attachment' in h.get('Content-Disposition',''),'MP3 download returns an actual audio file')
        check(request('/api/jobs/'+jid+'/favorite',{'favorite':True},token=token)[0]==200,'Favorite can be saved')
        process.terminate();process.wait(timeout=10)
        process,base=start()
        saved=next(j for j in getstate()['jobs'] if j['id']==jid)
        check(saved['favorite'] and saved['status']=='done','Finished remix and favorite survive app restart')
        print('ALL CHECKS PASSED. Test artifacts: '+str(temp),flush=True)
    finally:
        if process and process.poll() is None: process.terminate();process.wait(timeout=10)

if __name__=='__main__':main()
