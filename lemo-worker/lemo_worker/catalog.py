import hashlib, json, os
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
LOCK=json.loads((ROOT/'upstream.lock.json').read_text())
ORIGINAL=json.loads((ROOT/'style-directions.json').read_text())
def style_library():
    return os.environ.get('LEMO_STYLE_LIBRARY','cloudbath-original-v1')
def required_gates():
    library=style_library()
    permission_gates=['LEMO_ORIGINAL_STYLE_VERIFIED'] if library==ORIGINAL['version'] else ['LEMO_FILM_USE_APPROVED','LEMO_PRIVATE_OWNER_MODE'] if library=='owner-films' else ['LEMO_LICENSE_APPROVED']
    return ['LEMO_ENABLED',*permission_gates,'LEMO_SECURITY_VERIFIED','LEMO_RENDER_VERIFIED','LEMO_V4_VERIFIED','LEMO_SFX_V3_VERIFIED','LEMO_THAI_SYNC_VERIFIED','LEMO_COST_VERIFIED','LEMO_CLASSIC_REGRESSION_VERIFIED']
GATES=required_gates()


def enabled():
    return style_library() in (ORIGINAL['version'],'owner-films','upstream-licensed') and all(os.environ.get(k)=='true' for k in required_gates())


def style_spec(style):
    library=style_library()
    if library==ORIGINAL['version']:
        if os.environ.get('LEMO_ORIGINAL_STYLE_VERIFIED')!='true':
            raise RuntimeError('Original direction and MIT dependency review has not been recorded')
        if style not in ORIGINAL['styles']:raise ValueError('Unknown original visual direction')
        return ORIGINAL['styles'][style]
    if library in ('owner-films','upstream-licensed'):return private_spec(style)
    raise ValueError('Unknown style library')


def private_spec(style):
    # Upstream's additional permission covers the owner's/team's own films,
    # including commercial/social/client films. It is not a SaaS distribution grant.
    owner_use=style_library()=='owner-films' and os.environ.get('LEMO_FILM_USE_APPROVED')=='true' and os.environ.get('LEMO_PRIVATE_OWNER_MODE')=='true'
    commercial=style_library()=='upstream-licensed' and os.environ.get('LEMO_LICENSE_APPROVED')=='true'
    if not (owner_use or commercial):raise RuntimeError('Private film-use permission or commercial style permission has not been recorded')
    item=next((s for s in LOCK['styles'] if s['id']==style),None)
    if not item:raise ValueError('Style is not installed in this renderer')
    # Railway can provision these privately on the coordinator without baking
    # the documents into an image or requiring a writable persistent mount.
    # Railway limits each variable to 32 KiB. Individual pinned styles fit;
    # their combined JSON bundle can exceed that limit.
    individual=os.environ.get('LEMO_PRIVATE_STYLE_'+style.upper().replace('-','_'))
    bundle=os.environ.get('LEMO_PRIVATE_STYLES_JSON')
    if individual is not None:
        if len(individual.encode())>32768:raise ValueError('Private style exceeds variable limit')
        data=individual.encode()
    elif bundle is not None:
        if len(bundle)>150000:raise ValueError('Private style bundle exceeds limit')
        specs=json.loads(bundle)
        if not isinstance(specs,dict) or not isinstance(specs.get(style),str):
            raise ValueError('Pinned private style is missing from the bundle')
        data=specs[style].encode()
    else:
        root=Path(os.environ['LEMO_PRIVATE_LIBRARY']).resolve()
        path=(root/'styles'/style/'STYLE.md').resolve()
        if not path.is_relative_to(root):raise ValueError('Style path escapes private library')
        data=path.read_bytes()
    if hashlib.sha256(data).hexdigest()!=item['spec_sha256']:raise ValueError('Private style does not match pinned version')
    return data.decode()
