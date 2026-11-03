"""Google Drive delivery with resumable uploads and checksum verification.
The OAuth client secret stays on motion-api; the worker asks it for short-lived access tokens over the private network."""
import hashlib, json, os, time
import requests
from . import config

API = 'https://www.googleapis.com/drive/v3'
UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'
FOLDER = 'application/vnd.google-apps.folder'


class DriveError(RuntimeError):
    pass


class Drive:
    def __init__(self):
        self._tok, self._exp = None, 0

    def token(self):
        if self._tok and time.time() < self._exp - 120:
            return self._tok
        r = requests.get(config.API_INTERNAL_URL + '/internal/google/access-token',
                         headers={'x-internal-token': config.INTERNAL_TOKEN}, timeout=30)
        if r.status_code != 200:
            raise DriveError(f'Drive token unavailable ({r.status_code}): {r.text[:300]}')
        d = r.json()
        self._tok, self._exp = d['access_token'], time.time() + int(d.get('expires_in', 3000))
        return self._tok

    def h(self, extra=None):
        h = {'authorization': f'Bearer {self.token()}'}
        if extra:
            h.update(extra)
        return h

    def find(self, name, parent=None, mime=None):
        q = ["trashed=false", "name='%s'" % name.replace("'", "\\'")]
        if parent:
            q.append(f"'{parent}' in parents")
        if mime:
            q.append(f"mimeType='{mime}'")
        r = requests.get(API + '/files', headers=self.h(), params={'q': ' and '.join(q), 'fields': 'files(id,name,webViewLink)', 'spaces': 'drive'}, timeout=60)
        r.raise_for_status()
        f = r.json()['files']
        return f[0] if f else None

    def folder(self, name, parent=None):
        ex = self.find(name, parent, FOLDER)
        if ex:
            return ex
        meta = {'name': name, 'mimeType': FOLDER}
        if parent:
            meta['parents'] = [parent]
        r = requests.post(API + '/files', headers=self.h({'content-type': 'application/json'}), params={'fields': 'id,name,webViewLink'},
                          data=json.dumps(meta), timeout=60)
        r.raise_for_status()
        return r.json()

    def upload(self, path, name, parent, mime, chunk=8 * 1024 * 1024):
        size = os.path.getsize(path)
        md5 = hashlib.md5(open(path, 'rb').read()).hexdigest()
        existing = self.find(name, parent)
        if existing:
            got = self.meta(existing['id'])
            if got.get('md5Checksum') == md5 and int(got.get('size', -1)) == size:
                return {**got, 'verified': True, 'reused': True}
        r = requests.post(UPLOAD, params={'uploadType': 'resumable', 'fields': 'id'},
                          headers=self.h({'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': mime, 'x-upload-content-length': str(size)}),
                          data=json.dumps({'name': name, 'parents': [parent]}), timeout=60)
        r.raise_for_status()
        session = r.headers['location']
        pos = 0
        with open(path, 'rb') as f:
            while True:
                f.seek(pos)
                data = f.read(chunk)
                end = pos + len(data) - 1
                hdr = {'content-length': str(len(data)), 'content-range': f'bytes {pos}-{end}/{size}' if data else f'bytes */{size}'}
                rr = requests.put(session, headers=self.h(hdr), data=data, timeout=300)
                if rr.status_code in (200, 201):
                    fid = rr.json()['id']
                    break
                if rr.status_code == 308:
                    rng = rr.headers.get('range')
                    pos = int(rng.split('-')[1]) + 1 if rng else 0
                    continue
                if rr.status_code >= 500:
                    time.sleep(3)
                    q = requests.put(session, headers=self.h({'content-length': '0', 'content-range': f'bytes */{size}'}), timeout=60)
                    rng = q.headers.get('range')
                    pos = int(rng.split('-')[1]) + 1 if rng else 0
                    continue
                raise DriveError(f'upload {name} failed: {rr.status_code} {rr.text[:300]}')
        got = self.meta(fid)
        ok = got.get('md5Checksum') == md5 and int(got.get('size', -1)) == size
        if not ok:
            raise DriveError(f'upload verification failed for {name}: {got}')
        return {**got, 'verified': True}

    def meta(self, fid):
        r = requests.get(f'{API}/files/{fid}', headers=self.h(), params={'fields': 'id,name,size,md5Checksum,webViewLink,mimeType'}, timeout=60)
        r.raise_for_status()
        return r.json()
