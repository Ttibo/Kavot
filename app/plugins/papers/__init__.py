"""Papers plugin: article library, PDF reading, citations, discovery, Zotero and article watches."""
from __future__ import annotations


def register(registry, manifest) -> None:
    from app.core.records.repository import json_values
    from app.plugins.papers import library, mcp, search
    from app.plugins.papers.models import PaperImportConfirm, PaperUpdate
    from app.plugins.papers.routes import article_watch, discovery, integrations, library as library_routes

    registry.routers += [library_routes.router, article_watch.router, integrations.router, discovery.router]
    registry.mcp_tools.append(mcp.install)
    registry.search_sources.append(search.documents)
    registry.link_sources.append(citation_links)
    registry.agent_guides["papers"] = GUIDE
    registry.card_builders["articles"] = search.article_card

    def import_paper(payload, identifier, values):
        result, _ = library.import_paper(json_values(payload))
        return {"id": result["id"]}

    def update_paper(payload, identifier, values):
        return {"id": library.update_paper(int(identifier), json_values(payload, exclude_unset=True))["id"]}

    registry.agent_actions.update({
        "paper_import": {"model": PaperImportConfirm, "state_key": "papers", "apply": import_paper, "areas": ["papers", "citations"],
                         "summary": "Import an article from metadata (DOI, title, authors…)."},
        "paper_update": {"model": PaperUpdate, "state_key": "papers", "apply": update_paper, "areas": ["papers", "reader"],
                         "summary": "Change an article's metadata (only send changed fields)."},
    })


GUIDE = """Articles: search(query, collections=["articles"]) finds the user's library by metadata and by
PDF page (kavot://articles/<id>#page-<n>); read opens a page. In the citation graph, the context
is ALL related articles of the active search, including hidden or paged ones: call
get_article_pack and follow next_offset until null before drawing conclusions about the pack.
search_articles searches online (OpenAlex) and imports nothing; get_related_articles explores
references (earlier, cited work) and citations (later, citing work) of a pack reference, DOI or
OpenAlex ID; get_article_details fetches up to eight abstracts. Justify relevance with DOI/URL
and the level of evidence; do not claim to have read PDFs you did not read. Provider errors
mean partial coverage. At most 30 online lookups per request. To set up a research watch, call
get_watch_research_context, then search_articles to test the proposed terms; the suggested
settings stay to be reviewed in the watch form. To file articles use paper_organize with
folder_ids; to create a subfolder, paper_folder_create with parent_id."""


def citation_links(state):
    for citation in state.get("citations", []):
        if citation.get("source_id") is not None and citation.get("target_id") is not None:
            yield {"source": f"kavot://articles/{citation['source_id']}", "relation": "cites",
                   "target": f"kavot://articles/{citation['target_id']}", "provenance": "papers:citations"}
