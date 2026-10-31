"""UI gateway for independently installed agent CLIs: their settings and every agent conversation."""
from typing import Literal

from fastapi import APIRouter, File, UploadFile
from pydantic import BaseModel, ConfigDict, Field

from app.core.agents import install, sessions as external_agents
from app.core.agents.resources import inventory, save_attachment

router = APIRouter(prefix="/external-agents", tags=["external-agents"])
Engine = Literal["codex", "claude", "opencode"]


class EngineSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    enabled: bool = False
    executable: str = Field(default="", max_length=1000)
    model: str = Field(default="", max_length=200)
    effort: str = Field(default="", max_length=60)
    answer_model: str = Field(default="", max_length=200)
    answer_effort: str = Field(default="", max_length=60)
    digest_model: str = Field(default="", max_length=200)
    access: Literal["read", "write"] = "read"


class SettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    engines: dict[Engine, EngineSettings]


class SessionCreate(BaseModel):
    engine: Engine
    vendor_session_id: str | None = Field(default=None, min_length=1, max_length=120)
    project_id: int | None = None


class SessionRename(BaseModel):
    title: str = Field(min_length=1, max_length=120)


class MessageCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=50000)
    context: dict | None = None
    model: str | None = Field(default=None, max_length=200)
    effort: str | None = Field(default=None, max_length=60)
    mode: Literal["answer", "propose", "auto"] = "answer"


class ProposalDecision(BaseModel):
    decision: Literal["apply", "dismiss"]


class CheckRequest(BaseModel):
    executable: str = Field(default="", max_length=1000)


@router.get("/settings")
def get_settings():
    return external_agents.public_settings()


@router.patch("/settings")
def save_settings(payload: SettingsUpdate):
    return external_agents.configure({engine: value.model_dump() for engine, value in payload.engines.items()})


@router.post("/settings/{engine}/check")
def check_settings(engine: Engine, payload: CheckRequest):
    return external_agents.check(engine, payload.executable)


@router.get("/settings/{engine}/install")
def install_plan(engine: Engine):
    return install.plan(engine)


@router.post("/settings/{engine}/install", status_code=202)
def start_install(engine: Engine):
    return install.start(engine)


@router.get("/installs/{job_id}")
def get_install(job_id: str):
    return install.get(job_id)


@router.post("/settings/{engine}/login")
def login(engine: Engine):
    return install.login(engine)


@router.get("/models/{engine}")
def models(engine: Engine, refresh: bool = False, executable: str = ""):
    from app.core.agents.engines import discover
    from app.core.kernel.config import settings
    from fastapi import HTTPException
    binary = external_agents._resolve_executable(engine, executable or external_agents.configuration()[engine]["executable"])
    if not binary:
        raise HTTPException(422, "Program not found. Check its path in the settings.")
    settings.storage_path.mkdir(parents=True, exist_ok=True)
    return discover(engine, binary, str(settings.storage_path.resolve()), refresh)


@router.get("/sessions")
def sessions(engine: Engine | None = None, project_id: int | None = None):
    """Conversations of every engine, or of one; of every project, or of one."""
    return external_agents.list_sessions(engine, project_id)


@router.post("/sessions", status_code=201)
def create_session(payload: SessionCreate):
    return external_agents.create_session(payload.engine, payload.vendor_session_id, project_id=payload.project_id)


@router.get("/sessions/{session_id}")
def get_session(session_id: str):
    return external_agents.get_session(session_id)


@router.patch("/sessions/{session_id}")
def rename_session(session_id: str, payload: SessionRename):
    return external_agents.rename_session(session_id, payload.title)


@router.delete("/sessions/{session_id}", status_code=204)
def delete_session(session_id: str) -> None:
    external_agents.delete_session(session_id)


@router.post("/sessions/{session_id}/messages", status_code=202)
def send_message(session_id: str, payload: MessageCreate):
    return external_agents.start_message(session_id, payload.text, payload.context, payload.model, payload.effort, payload.mode)


@router.get("/resources")
def resources():
    return inventory()


@router.post("/context")
def preview_context(payload: MessageCreate):
    from app.core.agents.context import prepare
    context, resources, target = prepare(payload.context, payload.text, include_sources=False)
    return {"resources": resources, "target": target, "note_intent": context.get("note_intent"), "view_label": context.get("view_label"),
            "project": context.get("project"), "code_repository": context.get("code_repository"), "filters": context.get("filters"),
            "selection": context.get("selected_node_id") or (context.get("citation_graph") or {}).get("selected")}


@router.post("/attachments", status_code=201)
def upload_attachment(file: UploadFile = File(...)):
    return save_attachment(file.filename or "document", file.file)


@router.get("/runs/{run_id}")
def get_run(run_id: str):
    return external_agents.get_run(run_id)


@router.post("/runs/{run_id}/cancel")
def cancel_run(run_id: str):
    return external_agents.cancel_run(run_id)


@router.post("/runs/{run_id}/proposals/{proposal_id}")
def decide_proposal(run_id: str, proposal_id: str, payload: ProposalDecision):
    return external_agents.decide_proposal(run_id, proposal_id, payload.decision)
