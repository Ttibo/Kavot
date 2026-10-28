"""Versioned workspace ZIPs stored in the account's private cloud files."""
from __future__ import annotations

import hashlib
import re
import tempfile
import time
import uuid
from pathlib import Path

import httpx
from fastapi import HTTPException, UploadFile

from app.core.storage.cloud_sync.client import CloudError, LocalSync, https_url, s3_error
from app.core.storage import backups as workspace_backups


def _rows(sync: LocalSync) -> list[dict]:
    rows = []
    offset = 0
    while True:
        page = sync.api("GET", f"/files?offset={offset}")
        rows.extend(item for item in page if item["name"].lower().endswith(".zip"))
        if len(page) < 100:
            return rows
        offset += len(page)


AUTO_PREFIX = "kavot-backup-auto-"
ONLINE_AUTO_KEEP = 10


def _kind(name: str) -> str:
    return "auto" if name.startswith(AUTO_PREFIX) else "manual" if name.startswith("kavot-backup-") else "uploaded"


def list_backups(sync: LocalSync) -> list[dict]:
    rows = _rows(sync)  # The cloud lists newest first.
    numbers = {row["id"]: number for number, row in enumerate(sorted(rows, key=lambda row: row["created_at"]), 1)}
    return [{**row, "kind": _kind(row["name"]), "version": _kind(row["name"]) != "uploaded",
             "number": numbers[row["id"]], "local_id": local_id(row["name"])} for row in rows]


LOCAL_ID = re.compile(r"^kavot-backup-(?:auto-)?\d{8}-\d{6}-([0-9a-f-]{36})\.zip$")


def local_id(name: str) -> str | None:
    """The local version an online copy was made from, so both show as one backup."""
    match = LOCAL_ID.match(name)
    return match.group(1) if match else None


def _item(sync: LocalSync, identifier: uuid.UUID) -> dict:
    item = next((row for row in _rows(sync) if row["id"] == str(identifier)), None)
    if item is None:
        raise HTTPException(404, "Online ZIP not found")
    return item


def _response(response: httpx.Response) -> dict:
    try:
        body = response.json()
    except ValueError as error:
        raise CloudError(502, "Invalid cloud response.") from error
    if response.is_error:
        raise CloudError(response.status_code, body.get("detail", "Cloud operation rejected."))
    return body


def _upload(sync: LocalSync, source, name: str) -> dict:
    """Send the ZIP straight to S3: the cloud reserves the quota, signs and verifies."""
    digest, size = hashlib.sha256(), 0
    source.seek(0)
    while chunk := source.read(1024 * 1024):
        digest.update(chunk)
        size += len(chunk)
    try:
        reservation = sync.api("POST", "/files/uploads", {"name": name, "size": size, "sha256": digest.hexdigest()})
    except CloudError as error:
        if error.status not in {404, 405}:
            raise
        return _upload_through_api(sync, source, name)  # A cloud without direct uploads.
    upload, path = reservation["upload"], f"/files/uploads/{reservation['id']}"
    source.seek(0)
    try:
        # A separate HTTP client: the account token never goes to S3.
        with httpx.Client(transport=sync.s3_transport, timeout=120, follow_redirects=False, trust_env=False) as client:
            if upload.get("multipart"):
                number = 1
                while chunk := source.read(upload["part_size"]):
                    part = sync.api("POST", f"{path}/parts/{number}", {"sha256": hashlib.sha256(chunk).hexdigest()})
                    response = client.put(https_url(part["url"]), content=chunk, headers=part["headers"])
                    if response.status_code not in (200, 201, 204):
                        raise s3_error(response, f"Upload of part {number}")
                    number += 1
            else:
                response = client.put(https_url(upload["url"]), content=source, headers=upload["headers"])
                # 412: already stored after a lost response; completion verifies it.
                if response.status_code not in (200, 201, 204, 412):
                    raise s3_error(response)
    except httpx.HTTPError as error:
        raise CloudError(503, "Cloud storage unreachable. The ZIP was not uploaded.") from error
    return sync.api("POST", f"{path}/complete")


def _upload_through_api(sync: LocalSync, source, name: str) -> dict:
    token = sync.token()
    if not token:
        raise CloudError(401, "Link this device to your Kavot account.")
    source.seek(0)
    try:
        with httpx.Client(transport=sync.api_transport, trust_env=False, follow_redirects=False,
                          timeout=httpx.Timeout(30, read=600, write=600)) as client:
            response = client.post(sync.origin + "/api/cloud/files",
                                   headers={"Authorization": "Bearer " + token},
                                   files={"file": (name, source, "application/zip")})
    except httpx.HTTPError as error:
        raise CloudError(503, "Cloud unreachable. The ZIP was not uploaded.") from error
    return _response(response)


def create_backup(sync: LocalSync) -> dict:
    if not sync.token():
        raise CloudError(401, "Link this device to your Kavot account.")
    local = workspace_backups.create_backup()
    return upload_local(sync, local["id"])


def upload_local(sync: LocalSync, identifier: str, *, automatic: bool = False) -> dict:
    """Copy an existing local version online; automatic copies keep the latest ten."""
    path = workspace_backups.backup_path(identifier)
    prefix = AUTO_PREFIX if automatic else "kavot-backup-"
    name = f"{prefix}{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}-{identifier}.zip"
    with path.open("rb") as source:
        result = _upload(sync, source, name)
    if automatic:
        automatic_rows = sorted((row for row in _rows(sync) if row["name"].startswith(AUTO_PREFIX)),
                                key=lambda row: row["created_at"], reverse=True)
        for row in automatic_rows[ONLINE_AUTO_KEEP:]:
            sync.api("DELETE", f"/files/{row['id']}")
    return result


def upload_backup(sync: LocalSync, file: UploadFile) -> dict:
    name = Path((file.filename or "").replace("\\", "/")).name
    if not name.lower().endswith(".zip"):
        raise HTTPException(422, "Choose a ZIP backup")
    workspace_backups.validate_archive(file.file)
    return _upload(sync, file.file, name)


def _receive(response: httpx.Response, output, size: int):
    digest, received = hashlib.sha256(), 0
    for chunk in response.iter_bytes():
        received += len(chunk)
        if received > size:
            raise CloudError(502, "Online ZIP size differs from its listing.")
        digest.update(chunk)
        output.write(chunk)
    if received != size:
        raise CloudError(502, "Online ZIP download is incomplete.")
    return digest


def download_backup(sync: LocalSync, identifier: uuid.UUID) -> tuple[Path, dict]:
    item = _item(sync, identifier)
    token = sync.token()
    if not token:
        raise CloudError(401, "Link this device to your Kavot account.")
    try:
        link = sync.api("GET", f"/files/{identifier}/link")
    except CloudError as error:
        if error.status != 404:
            raise
        link = None  # A cloud without download links streams the file itself.
    with tempfile.NamedTemporaryFile(prefix="kavot-online-backup-", suffix=".zip", delete=False) as temp:
        path = Path(temp.name)
    try:
        if link:
            with httpx.Client(transport=sync.s3_transport, timeout=httpx.Timeout(30, read=600),
                              follow_redirects=False, trust_env=False) as client:
                with client.stream("GET", https_url(link["url"])) as response:
                    if response.status_code != 200:
                        response.read()
                        raise s3_error(response, "Download")
                    with path.open("wb") as output:
                        digest = _receive(response, output, link["size"])
            # Files stored before direct transfers have no recorded checksum.
            if link.get("sha256") and digest.hexdigest() != link["sha256"]:
                raise CloudError(502, "The online ZIP checksum is wrong.")
        else:
            with httpx.Client(transport=sync.api_transport, trust_env=False, follow_redirects=False,
                              timeout=httpx.Timeout(30, read=600)) as client:
                with client.stream("GET", sync.origin + f"/api/cloud/files/{identifier}/download",
                                   headers={"Authorization": "Bearer " + token}) as response:
                    if response.is_error:
                        response.read()
                        _response(response)
                    with path.open("wb") as output:
                        _receive(response, output, item["size"])
    except httpx.HTTPError as error:
        path.unlink(missing_ok=True)
        raise CloudError(503, "Cloud unreachable. The ZIP was not downloaded.") from error
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return path, item


def restore_backup(sync: LocalSync, identifier: uuid.UUID) -> dict:
    path, _ = download_backup(sync, identifier)
    try:
        return workspace_backups.restore_archive(path, str(identifier))
    finally:
        path.unlink(missing_ok=True)


def delete_backup(sync: LocalSync, identifier: uuid.UUID) -> None:
    _item(sync, identifier)
    sync.api("DELETE", f"/files/{identifier}")
