import hashlib, json, os
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
LOCK=json.loads((ROOT/'upstream.lock.json').read_text())
GATES=['LEMO_ENABLED','LEMO_LICENSE_APPROVED','LEMO_SECURITY_VERIFIED','LEMO_RENDER_VERIFIED','LEMO_V4_VERIFIED','LEMO_SFX_V3_VERIFIED','LEMO_THAI_SYNC_VERIFIED','LEMO_COST_VERIFIED','LEMO_CLASSIC_REGRESSION_VERIFIED']


def enabled():
    return all(os.environ.get(k)=='true' for k in GATES)


def private_spec(style):
    item=next((s for s in LOCK['styles'] if s['id']==style),None)
    if not item:raise ValueError('Style is not installed in this renderer')
    root=Path(os.environ['LEMO_PRIVATE_LIBRARY']).resolve()
    path=(root/'styles'/style/'STYLE.md').resolve()
    if not path.is_relative_to(root):raise ValueError('Style path escapes private library')
    data=path.read_bytes()
    if hashlib.sha256(data).hexdigest()!=item['spec_sha256']:raise ValueError('Private style does not match pinned version')
    if os.environ.get('LEMO_LICENSE_APPROVED')!='true':raise RuntimeError('Commercial style permission has not been recorded')
    return data.decode()
