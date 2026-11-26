import hashlib, json, os
from functools import lru_cache

import requests
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
LOCK=json.loads((ROOT/'upstream.lock.json').read_text())
CATALOG=json.loads((ROOT/'upstream-catalog.lock.json').read_text())
UPSTREAM_RAW='https://raw.githubusercontent.com/lemomo-ai/lemo-opuscar'
MAX_SPEC_BYTES=32768
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


@lru_cache(maxsize=99)
def upstream_spec(style, expected_hash):
    # `style` comes from the pinned catalog; no owner input controls this endpoint.
    url=f"{UPSTREAM_RAW}/{LOCK['commit']}/styles/{style}/STYLE.md"
    for attempt in range(2):
        try:
            with requests.get(url, timeout=(12, 20), allow_redirects=False, stream=True) as response:
                if response.status_code!=200:
                    raise RuntimeError('Pinned style is unavailable; no production calls submitted')
                content=bytearray()
                for chunk in response.iter_content(4096):
                    content.extend(chunk)
                    if len(content)>MAX_SPEC_BYTES:raise ValueError('Private style exceeds size limit')
            break
        except (requests.Timeout, requests.ConnectionError) as error:
            if attempt:
                raise RuntimeError('Could not read pinned style; no production calls submitted') from error
    spec=bytes(content)
    if hashlib.sha256(spec).hexdigest()!=expected_hash:
        raise ValueError('Private style does not match pinned version')
    return spec


def private_spec(style):
    # Upstream's additional permission covers the owner's/team's own films,
    # including commercial/social/client films. It is not a SaaS distribution grant.
    owner_use=style_library()=='owner-films' and os.environ.get('LEMO_FILM_USE_APPROVED')=='true' and os.environ.get('LEMO_PRIVATE_OWNER_MODE')=='true'
    commercial=style_library()=='upstream-licensed' and os.environ.get('LEMO_LICENSE_APPROVED')=='true'
    if not (owner_use or commercial):raise RuntimeError('Private film-use permission or commercial style permission has not been recorded')
    item=next((s for s in LOCK['styles'] if s['id']==style),None)
    full=os.environ.get('LEMO_FULL_STYLE_CATALOG')=='true' and CATALOG['upstream']==LOCK.get('commit')
    expected_hash=CATALOG['styles'].get(style) if full else item and item['spec_sha256']
    if not expected_hash:raise ValueError('Style is not installed in this renderer')
    # Railway can provision these privately on the coordinator without baking
    # the documents into an image or requiring a writable persistent mount.
    # Railway limits each variable to 32 KiB. Individual pinned styles fit;
    # their combined JSON bundle can exceed that limit.
    individual=os.environ.get('LEMO_PRIVATE_STYLE_'+style.upper().replace('-','_'))
    bundle=os.environ.get('LEMO_PRIVATE_STYLES_JSON')
    if individual is not None:
        if len(individual.encode())>MAX_SPEC_BYTES:raise ValueError('Private style exceeds variable limit')
        data=individual.encode()
    elif bundle is not None:
        if len(bundle)>150000:raise ValueError('Private style bundle exceeds limit')
        specs=json.loads(bundle)
        if not isinstance(specs,dict) or not isinstance(specs.get(style),str):
            raise ValueError('Pinned private style is missing from the bundle')
        data=specs[style].encode()
    elif os.environ.get('LEMO_PRIVATE_LIBRARY') or not full:
        root=Path(os.environ['LEMO_PRIVATE_LIBRARY']).resolve()
        path=(root/'styles'/style/'STYLE.md').resolve()
        if not path.is_relative_to(root):raise ValueError('Style path escapes private library')
        data=path.read_bytes()
    else:
        data=upstream_spec(style,expected_hash)
    if len(data)>MAX_SPEC_BYTES:raise ValueError('Private style exceeds size limit')
    if hashlib.sha256(data).hexdigest()!=expected_hash:raise ValueError('Private style does not match pinned version')
    return data.decode()
