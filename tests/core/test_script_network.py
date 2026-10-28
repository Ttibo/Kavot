"""kavot.fetch proxy: approved URLs only, never local or private addresses."""
import httpx
import pytest

from app.core.workspace import script_network


def test_url_key_ignores_query_fragment_and_default_port():
    assert script_network.url_key("HTTPS://Api.Example.com:443/v1/items?q=1#top") == "https://api.example.com/v1/items"
    assert script_network.url_key("http://example.com") == "http://example.com/"
    assert script_network.url_key("http://example.com:8080/a") == "http://example.com:8080/a"
    for bad in ("ftp://example.com/", "file:///etc/passwd", "https://user:pw@example.com/", "not a url"):
        with pytest.raises(script_network.ScriptNetworkError):
            script_network.url_key(bad)


def test_unapproved_url_asks_for_approval_then_can_be_revoked(client):
    url = "https://api.example.com/data"
    assert client.post("/api/note-scripts/network/fetch", json={"url": url + "?page=2"}).json() == {"approved": False, "url": url}
    assert client.post("/api/note-scripts/network/approvals", json={"url": url, "script": "Weather"}).status_code == 201
    assert [entry["url"] for entry in client.get("/api/note-scripts/network/approvals").json()] == [url]
    assert client.delete("/api/note-scripts/network/approvals", params={"url": url}).status_code == 204
    assert client.get("/api/note-scripts/network/approvals").json() == []


@pytest.mark.parametrize("url", ["http://127.0.0.1:8000/api/notes", "http://localhost/", "http://192.168.1.10/", "http://[::1]/"])
def test_local_and_private_addresses_are_refused_even_when_approved(client, url):
    client.post("/api/note-scripts/network/approvals", json={"url": url})
    response = client.post("/api/note-scripts/network/fetch", json={"url": url})
    assert response.status_code == 422 and "private" in response.json()["detail"]
    client.delete("/api/note-scripts/network/approvals", params={"url": url})


def test_redirect_to_an_unapproved_url_asks_again(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/start":
            assert "cookie" not in request.headers
            return httpx.Response(302, headers={"location": "https://other.example.com/next"})
        return httpx.Response(200, headers={"set-cookie": "a=b", "content-type": "text/plain"}, text="done")

    real_client = httpx.Client
    monkeypatch.setattr(script_network.httpx, "Client", lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))
    monkeypatch.setattr(script_network, "_check_public", lambda host: None)
    monkeypatch.setattr(script_network, "load_script_network", lambda: [{"url": "https://api.example.com/start"}])
    assert script_network.fetch("https://api.example.com/start", headers={"Cookie": "x"}) == {"approved": False, "url": "https://other.example.com/next"}

    monkeypatch.setattr(script_network, "load_script_network", lambda: [{"url": "https://api.example.com/start"}, {"url": "https://other.example.com/next"}])
    result = script_network.fetch("https://api.example.com/start")
    assert result["status"] == 200 and result["url"] == "https://other.example.com/next"
    assert all(name.lower() != "set-cookie" for name, _ in result["headers"])
    assert result["body"] == "ZG9uZQ=="
