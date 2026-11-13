"""Fixed entrypoint inside an isolated, credential-free Railway VM."""
import json,sys
from pathlib import Path
from executor import run,verify_runtime

image=Path('/opt/lemo/image-id.txt').read_text().strip()
if sys.argv[1:] == ['ready']:
    print(json.dumps({'ready':True,'image':image,'limits':verify_runtime(image)}))
elif sys.argv[1:] == ['render']:
    raw=Path('/tmp/lemo-input.json').read_bytes()
    if len(raw)>800000:raise ValueError('Input exceeds limit')
    archive,metadata=run(json.loads(raw),image=image,timeout=300)
    Path('/tmp/lemo-output.tar').write_bytes(archive)
    print(json.dumps(metadata))
else:
    raise ValueError('Unknown fixed renderer operation')
