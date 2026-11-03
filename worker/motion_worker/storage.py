"""Durable artifact storage on the Railway bucket (S3-compatible). A local directory backend exists for development."""
import hashlib, os, shutil
from . import config


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


class S3Storage:
    def __init__(self):
        import boto3
        from botocore.config import Config
        self.bucket = config.BUCKET
        self.s3 = boto3.client(
            's3', endpoint_url=config.BUCKET_ENDPOINT or None, region_name=config.BUCKET_REGION,
            aws_access_key_id=config.BUCKET_KEY, aws_secret_access_key=config.BUCKET_SECRET,
            config=Config(s3={'addressing_style': 'path' if config.BUCKET_URL_STYLE == 'path' else 'virtual'},
                          retries={'max_attempts': 5, 'mode': 'standard'}))

    def put_file(self, key, path, content_type=None):
        extra = {'ContentType': content_type} if content_type else {}
        self.s3.upload_file(path, self.bucket, key, ExtraArgs=extra)
        return key

    def put_bytes(self, key, data, content_type=None):
        extra = {'ContentType': content_type} if content_type else {}
        self.s3.put_object(Bucket=self.bucket, Key=key, Body=data, **extra)
        return key

    def get_file(self, key, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + '.part'
        self.s3.download_file(self.bucket, key, tmp)
        os.replace(tmp, path)
        return path

    def exists(self, key):
        try:
            self.s3.head_object(Bucket=self.bucket, Key=key)
            return True
        except Exception:
            return False


class LocalStorage:
    def __init__(self, root):
        self.root = root

    def _p(self, key):
        p = os.path.join(self.root, key)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        return p

    def put_file(self, key, path, content_type=None):
        shutil.copyfile(path, self._p(key))
        return key

    def put_bytes(self, key, data, content_type=None):
        with open(self._p(key), 'wb') as f:
            f.write(data)
        return key

    def get_file(self, key, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        shutil.copyfile(os.path.join(self.root, key), path)
        return path

    def exists(self, key):
        return os.path.exists(os.path.join(self.root, key))


def get_storage():
    if config.BUCKET:
        return S3Storage()
    if config.LOCAL_STORAGE_DIR:
        return LocalStorage(config.LOCAL_STORAGE_DIR)
    raise RuntimeError('No storage configured: set BUCKET* variables (Railway bucket references)')
