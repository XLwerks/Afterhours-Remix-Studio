"""Isolated real-audio and API checks; never alters the user's music library."""
import json
import math
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
import numpy as np
import server

class PerformanceTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='afterhours-live-test-')
        self.old=(server.DATA,server.LIBRARY,server.STATE)
        server.DATA=Path(self.temp.name);server.LIBRARY=server.DATA/'library.json'
        self.jid='a'*32;folder=server.DATA/'jobs'/self.jid;folder.mkdir(parents=True)
        subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','sine=frequency=440:duration=4:sample_rate=44100','-ac','2','-c:a','pcm_s24le',str(folder/'remix.wav')],check=True)
        server.STATE={'tracks':{},'jobs':{self.jid:{'id':self.jid,'name':'Test','status':'done','created':1,'result':{'bpm':120,'duration':4,'sections':[{'name':'Groove','start':2,'end':4}]}}}}
        self.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        self.thread=threading.Thread(target=self.http.serve_forever,daemon=True);self.thread.start()
        self.base='http://127.0.0.1:'+str(self.http.server_port)
    def tearDown(self):
        self.http.shutdown();self.http.server_close();self.thread.join()
        server.DATA,server.LIBRARY,server.STATE=self.old;self.temp.cleanup()
    def request(self,path,data=None,token=True):
        req=urllib.request.Request(self.base+path,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json',**({'X-Studio-Token':server.TOKEN} if token else {})})
        return urllib.request.urlopen(req)
    def test_prepare_changes_duration_not_pitch_and_preserves_original(self):
        original=server.DATA/'jobs'/self.jid/'remix.wav';before=original.read_bytes()
        with self.request('/api/prepare-deck',{'id':self.jid,'bpm':150}) as r: result=json.load(r)
        self.assertAlmostEqual(result['duration'],3.2);self.assertAlmostEqual(result['sections'][0]['start'],1.6)
        path=server.DATA/'jobs'/self.jid/'set-150.0.wav';stamp=path.stat().st_mtime_ns
        audio=subprocess.check_output(['ffmpeg','-v','error','-i',str(path),'-ac','1','-f','f32le','-'])
        samples=np.frombuffer(audio,dtype='<f4');self.assertAlmostEqual(len(samples)/44100,3.2,places=3)
        mid=samples[22050:88200];freq=np.fft.rfftfreq(len(mid),1/44100)[np.argmax(abs(np.fft.rfft(mid)))];self.assertLess(abs(freq-440),2)
        self.assertEqual(before,original.read_bytes());server.prepare_deck(self.jid,150);self.assertEqual(stamp,path.stat().st_mtime_ns)
        with self.request(result['url']+'?download=1') as r:self.assertIn('attachment',r.headers['Content-Disposition']);self.assertGreater(len(r.read()),1000)
    def test_same_tempo_uses_saved_audio(self):
        result=server.prepare_deck(self.jid,120);self.assertTrue(result['url'].endswith('/remix.wav'));self.assertEqual(result['sections'][0]['start'],2)
    def test_crate_persists_and_validates_ids_tempo_and_auth(self):
        crate={'bpm':136,'ids':[self.jid]}
        with self.request('/api/setlist',crate) as r:self.assertEqual(r.status,200)
        self.assertEqual(json.loads(server.LIBRARY.read_text())['setlist'],crate)
        with self.request('/api/state') as r:self.assertEqual(json.load(r)['setlist'],crate)
        for invalid in ({'bpm':float('nan'),'ids':[]},{'bpm':136,'ids':[self.jid,self.jid]},{'bpm':136,'ids':['../../bad']},{'bpm':300,'ids':[]}):
            with self.assertRaises(urllib.error.HTTPError) as exc:self.request('/api/setlist',invalid)
            self.assertEqual(exc.exception.code,400)
        with self.assertRaises(urllib.error.HTTPError) as exc:self.request('/api/setlist',crate,token=False)
        self.assertEqual(exc.exception.code,403);self.assertEqual(json.loads(server.LIBRARY.read_text())['setlist'],crate)
    def test_new_scripts_are_served(self):
        for path in ['/mixer.js','/performance.js']:
            with self.request(path) as r:self.assertEqual(r.status,200);self.assertIn(b'use strict',r.read())

if __name__=='__main__':unittest.main()
