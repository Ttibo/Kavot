from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Response

from app.plugins.research.models import ConferenceInput, DatasetInput
from app.plugins.research import service as research


router = APIRouter(tags=["research"])


@router.get("/conferences")
def conferences(project_id: int | None = None, include_archived: bool = False) -> list[dict[str, Any]]:
    return research.list_conferences(project_id, include_archived)


@router.post("/conferences", status_code=201)
def create_conference(payload: ConferenceInput) -> dict[str, Any]:
    return research.save_research("conferences", payload)


@router.patch("/conferences/{conference_id}")
def update_conference(conference_id: int, payload: ConferenceInput) -> dict[str, Any]:
    return research.save_research("conferences", payload, conference_id)


@router.delete("/conferences/{conference_id}", status_code=204)
def delete_conference(conference_id: int) -> Response:
    research.delete_research("conferences", conference_id)
    return Response(status_code=204)


@router.get("/datasets")
def datasets(project_id: int | None = None, include_archived: bool = False) -> list[dict[str, Any]]:
    return research.list_datasets(project_id, include_archived)


@router.post("/datasets", status_code=201)
def create_dataset(payload: DatasetInput) -> dict[str, Any]:
    return research.save_research("datasets", payload)


@router.patch("/datasets/{dataset_id}")
def update_dataset(dataset_id: int, payload: DatasetInput) -> dict[str, Any]:
    return research.save_research("datasets", payload, dataset_id)


@router.delete("/datasets/{dataset_id}", status_code=204)
def delete_dataset(dataset_id: int) -> Response:
    research.delete_research("datasets", dataset_id)
    return Response(status_code=204)
