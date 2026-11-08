"""Errors of the cloud sync and the checks on the addresses it talks to."""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from urllib.parse import urlsplit


class CloudError(Exception):
    def __init__(self, status, detail, current=None):
        self.status, self.detail = status, detail
        self.current = current
        super().__init__(str(detail))


def https_url(value):
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise CloudError(422, "An HTTPS URL without credentials is required.")
    return value


S3_HINTS = {
    "SignatureDoesNotMatch": "Check the region, S3 address and credentials configured on the cloud server.",
    "AccessDenied": "Check the bucket access rights and that the S3 authorization is valid.",
    "InvalidAccessKeyId": "The S3 access key configured on the cloud server is invalid.",
    "RequestExpired": "The S3 authorization has expired. Run the sync again to renew it.",
    "ExpiredToken": "The cloud server’s S3 credentials have expired.",
    "RequestTimeTooSkewed": "Check the cloud server’s clock.",
    "BadDigest": "The storage rejected the uploaded file’s checksum.",
    "NotImplemented": "The storage does not support an option of the S3 transfer.",
    "PermanentRedirect": "The configured S3 address does not match the bucket’s region.",
}


def s3_error(response, operation="Upload"):
    """Expose actionable S3 diagnostics without leaking signed URLs or keys."""
    fields = {}
    try:
        root = ET.fromstring(response.content[:65536])
        fields = {node.tag.rsplit("}", 1)[-1]: node.text or "" for node in root.iter()}
    except ET.ParseError:
        pass
    code = fields.get("Code", "")
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9]{0,79}", code):
        code = ""
    detail = f"{operation} rejected by S3 (HTTP {response.status_code}{', ' + code if code else ''})."
    if code in {"AuthorizationQueryParametersError", "AuthorizationHeaderMalformed"}:
        expected = re.search(r"expecting ['\"]([a-z0-9-]{1,63})['\"]", fields.get("Message", ""))
        region = expected.group(1) if expected else fields.get("Region", "")
        if re.fullmatch(r"[a-z0-9-]{1,63}", region):
            detail += f" Wrong S3 region: set KAVOT_S3_REGION={region} on the cloud server, then reload the API configuration."
        else:
            detail += " Check the S3 region configured on the cloud server."
    else:
        detail += " " + S3_HINTS.get(code, "Check the cloud storage configuration, or try again if the service is temporarily unavailable.")
    detail += " The pending local copy is kept."
    return CloudError(503 if response.status_code >= 500 else 502, detail)
