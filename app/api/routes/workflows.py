from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Response
from pydantic import BaseModel, ConfigDict, Field

from app.core.automation import workflows

router = APIRouter(prefix="/workflows", tags=["workflows"])


class WorkflowNode(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=40)
    type: str = Field(min_length=1, max_length=40)
    x: float = 0
    y: float = 0
    label: str = Field(default="", max_length=120)
    config: dict[str, Any] = Field(default_factory=dict)


class WorkflowEdge(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(default="", max_length=90)
    source: str = Field(min_length=1, max_length=40)
    target: str = Field(min_length=1, max_length=40)


class WorkflowScope(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project_id: int | None = None
    paper_folder_id: int | None = None  # accepted from older clients, no longer used


class WorkflowInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=2000)
    scope: WorkflowScope = Field(default_factory=WorkflowScope)
    engine: Literal["codex", "claude", "opencode"] = "claude"
    model: str = Field(default="", max_length=200)
    interval_hours: int = Field(default=0, ge=0, le=24 * 30)
    timeout_minutes: int = Field(default=20, ge=5, le=120)
    enabled: bool = True
    nodes: list[WorkflowNode] = Field(default_factory=list, max_length=60)
    edges: list[WorkflowEdge] = Field(default_factory=list, max_length=150)


@router.get("")
def list_workflows():
    return workflows.list_workflows()


@router.post("", status_code=201)
def create_workflow(payload: WorkflowInput):
    return workflows.save(payload.model_dump())


@router.get("/{workflow_id}")
def get_workflow(workflow_id: int):
    return workflows.get(workflow_id)


@router.put("/{workflow_id}")
def update_workflow(workflow_id: int, payload: WorkflowInput):
    return workflows.save(payload.model_dump(), workflow_id)


@router.delete("/{workflow_id}", status_code=204)
def delete_workflow(workflow_id: int):
    workflows.delete(workflow_id)
    return Response(status_code=204)


@router.post("/{workflow_id}/run", status_code=202)
def run_workflow(workflow_id: int):
    return workflows.run(workflow_id)


@router.post("/{workflow_id}/cancel")
def cancel_workflow(workflow_id: int):
    return workflows.cancel(workflow_id)


@router.delete("/{workflow_id}/runs")
def clear_runs(workflow_id: int):
    return workflows.delete_runs(workflow_id)


@router.delete("/{workflow_id}/runs/{run_id}")
def delete_run(workflow_id: int, run_id: str):
    return workflows.delete_runs(workflow_id, run_id)


class ChangeDecision(BaseModel):
    run_id: str = Field(min_length=1, max_length=64)
    node_id: str = Field(min_length=1, max_length=40)
    proposal_id: str = Field(min_length=1, max_length=64)
    decision: Literal["apply", "dismiss"]


@router.post("/{workflow_id}/changes/decide")
def decide_change(workflow_id: int, payload: ChangeDecision):
    return workflows.decide_change(workflow_id, payload.run_id, payload.node_id, payload.proposal_id, payload.decision)
