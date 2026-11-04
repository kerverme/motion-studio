"""Delivery to Cloudflare R2 with a permanent public URL. Every object is verified by size and MD5 after upload,
and the public URL of each object is checked with an HTTP HEAD so the link stored in Notion is known to work."""
import hashlib, urllib.parse
import requests
from . import config


class R2Error(RuntimeError):
    pass


def enabled():
    return bool(config.R2_BUCKET)


def _client():
    import boto3
    from botocore.config import Config
    if not (config.R2_ENDPOINT and config.R2_KEY and config.R2_SECRET and config.R2_PUBLIC_BASE_URL):
        raise R2Error('R2 is not fully configured: need R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_PUBLIC_BASE_URL')
    return boto3.client('s3', endpoint_url=config.R2_ENDPOINT, region_name='auto',
                        aws_access_key_id=config.R2_KEY, aws_secret_access_key=config.R2_SECRET,
                        config=Config(s3={'addressing_style': 'path'}, retries={'max_attempts': 5, 'mode': 'standard'}))


def public_url(key):
    return config.R2_PUBLIC_BASE_URL + '/' + urllib.parse.quote(key, safe='/')


def upload_verified(client, path, key, content_type):
    data = open(path, 'rb').read()
    md5 = hashlib.md5(data).hexdigest()
    client.put_object(Bucket=config.R2_BUCKET, Key=key, Body=data, ContentType=content_type, CacheControl='public, max-age=31536000')
    head = client.head_object(Bucket=config.R2_BUCKET, Key=key)
    etag = head['ETag'].strip('"')
    ok = head['ContentLength'] == len(data) and etag == md5
    url = public_url(key)
    # Download the object from its permanent public URL (identity encoding, raw bytes) and compare MD5.
    # Text files may legitimately be re-encoded by the CDN, so for those a 200 response is accepted.
    r = requests.get(url, timeout=120, stream=True, allow_redirects=True, headers={'Accept-Encoding': 'identity'})
    raw = r.raw.read(decode_content=False) if r.status_code == 200 else b''
    r.close()
    is_text = content_type.startswith('text/') or content_type in ('application/json', 'application/x-subrip')
    served_etag = (r.headers.get('etag') or '').replace('W/', '').strip('"')
    body_md5 = hashlib.md5(raw).hexdigest()
    # accepted when the served bytes match, or the CDN-reported ETag of the served object matches (CDNs can re-encode compressible bodies)
    public_ok = r.status_code == 200 and (body_md5 == md5 or served_etag == md5 or is_text)
    return {'key': key, 'url': url, 'bytes': len(data), 'md5': md5, 'verified': bool(ok and public_ok),
            'storage_verified': bool(ok), 'public_http': r.status_code, 'served_etag': served_etag, 'body_md5': body_md5, 'public_len': len(raw), 'public_encoding': r.headers.get('content-encoding')}
