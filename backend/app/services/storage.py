"""Guarda los archivos originales del reloj: en disco local (desarrollo) o en S3 (AWS)."""

from pathlib import Path
from typing import Protocol

from app.core.config import get_settings


class Storage(Protocol):
    def save(self, key: str, content: bytes) -> str: ...

    def load(self, key: str) -> bytes: ...


class LocalStorage:
    def __init__(self, base_dir: str):
        self.base = Path(base_dir).resolve()

    def _path(self, key: str) -> Path:
        path = (self.base / key).resolve()
        if not path.is_relative_to(self.base):
            raise ValueError("Ruta de almacenamiento inválida")
        return path

    def save(self, key: str, content: bytes) -> str:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return key

    def load(self, key: str) -> bytes:
        return self._path(key).read_bytes()


class S3Storage:
    def __init__(self, bucket: str, prefix: str, region: str | None):
        import boto3

        self.bucket = bucket
        self.prefix = prefix
        self.client = boto3.client("s3", region_name=region)

    def save(self, key: str, content: bytes) -> str:
        full_key = f"{self.prefix}{key}"
        self.client.put_object(
            Bucket=self.bucket, Key=full_key, Body=content, ServerSideEncryption="AES256"
        )
        return full_key

    def load(self, key: str) -> bytes:
        return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()


def get_storage() -> Storage:
    settings = get_settings()
    if settings.storage_backend == "s3":
        return S3Storage(settings.s3_bucket, settings.s3_prefix, settings.aws_region)
    return LocalStorage(settings.storage_local_dir)
