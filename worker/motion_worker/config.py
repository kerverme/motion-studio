import os, socket

env = os.environ

DATABASE_URL = env.get('DATABASE_URL', '')
ELEVENLABS_API_KEY = env.get('ELEVENLABS_API_KEY', '')
ELEVENLABS_BASE = env.get('ELEVENLABS_BASE_URL', 'https://api.elevenlabs.io')
DEFAULT_VOICE_ID = env.get('MOTION_DEFAULT_VOICE_ID', 'bcdIY58WBBzAMmef52NW')  # "Zie - Friendly Thai Tech Narrator"
API_INTERNAL_URL = env.get('MOTION_API_INTERNAL_URL', 'http://motion-api.railway.internal:8080')
INTERNAL_TOKEN = env.get('MOTION_INTERNAL_TOKEN', '')
MAX_CREDITS = int(env.get('MOTION_MAX_CREDITS_PER_EPISODE', '6000'))
WORKDIR = env.get('MOTION_WORKDIR', '/tmp/motion')
WORKER_ID = env.get('RAILWAY_REPLICA_ID') or socket.gethostname()
POLL_SECONDS = float(env.get('MOTION_POLL_SECONDS', '5'))
RENDER_PROCS = int(env.get('MOTION_RENDER_PROCS', '0')) or max(1, (os.cpu_count() or 2))
DRIVE_ROOT = env.get('MOTION_DRIVE_ROOT', 'Motion Studio')
DRIVE_READY = env.get('MOTION_DRIVE_READY', 'Ready to Post')
TZ = env.get('TZ', 'Asia/Bangkok')

# Final delivery on Cloudflare R2 (S3 API). When R2_BUCKET is set it replaces the Google Drive delivery.
R2_BUCKET = env.get('R2_BUCKET', '')
R2_ENDPOINT = env.get('R2_ENDPOINT', '')  # https://<account_id>.r2.cloudflarestorage.com
R2_KEY = env.get('R2_ACCESS_KEY_ID', '')
R2_SECRET = env.get('R2_SECRET_ACCESS_KEY', '')
R2_PUBLIC_BASE_URL = env.get('R2_PUBLIC_BASE_URL', '').rstrip('/')  # permanent public base, e.g. https://pub-xxxx.r2.dev
R2_PREFIX = env.get('R2_PREFIX', 'ready-to-post')

BUCKET = env.get('BUCKET', '')
BUCKET_ENDPOINT = env.get('BUCKET_ENDPOINT', '')
BUCKET_REGION = env.get('BUCKET_REGION', 'auto')
BUCKET_KEY = env.get('BUCKET_ACCESS_KEY_ID', '')
BUCKET_SECRET = env.get('BUCKET_SECRET_ACCESS_KEY', '')
BUCKET_URL_STYLE = env.get('BUCKET_URL_STYLE', 'virtual')
LOCAL_STORAGE_DIR = env.get('MOTION_LOCAL_STORAGE', '')  # dev only
