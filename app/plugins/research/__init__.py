"""Research plugin: conferences and datasets."""
from __future__ import annotations


def register(registry, manifest) -> None:
    from app.plugins.research import routes, service
    from app.plugins.research.models import ConferenceInput, DatasetInput

    registry.routers.append(routes.router)
    registry.calendar_sources.append(service.calendar_events)

    def saver(collection):
        def apply(payload, identifier, values):
            return service.save_research(collection, payload, int(identifier) if identifier else None)
        return apply

    for prefix, collection, model in (("conference", "conferences", ConferenceInput), ("dataset", "datasets", DatasetInput)):
        for operation in ("create", "update"):
            registry.agent_actions[f"{prefix}_{operation}"] = {
                "model": model, "state_key": collection, "apply": saver(collection),
                # Updates merge with the stored item, so unchanged fields may be omitted.
                "partial": operation == "update",
                "areas": [collection],
                "summary": f"{operation.title()} a {prefix} (fields of get_collection('{collection}')).",
            }
