"""Local paths and credentials live in the user's .env file, never in os.environ."""
import json
import os

from app.core.kernel import env, user_settings


def test_values_round_trip_and_stay_out_of_the_process_environment():
    env.update({"KAVOT_TEST_PATH": r"C:\Users\me\new folder", "KAVOT_TEST_QUOTE": "it's \"x\"\nnext"})
    assert env.get("KAVOT_TEST_PATH") == r"C:\Users\me\new folder"
    assert env.get("KAVOT_TEST_QUOTE") == "it's \"x\"\nnext"
    assert "KAVOT_TEST_PATH" not in os.environ
    env.write("KAVOT_TEST_PATH", "")
    assert env.get("KAVOT_TEST_PATH", "gone") == "gone"
    assert env.user_file().read_text(encoding="utf-8").startswith("#")


def test_user_file_exists_after_startup(client):
    text = env.user_file().read_text(encoding="utf-8")
    assert text.startswith("#") and "KAVOT_ZOTERO_API_KEY" in text
    assert env.ensure_user_file().read_text(encoding="utf-8") == text


def test_parser_reads_common_dotenv_forms():
    assert env.parse("# note\nexport A=1\nB = two # comment\nC='lit\\n'\nD=\"a\\tb\"\nbad line") == {
        "A": "1", "B": "two", "C": "lit\\n", "D": "a\tb"}


def test_environment_wins_over_the_user_file(monkeypatch):
    env.write("KAVOT_TEST_PIN", "file")
    monkeypatch.setenv("KAVOT_TEST_PIN", "shell")
    assert env.get("KAVOT_TEST_PIN") == "shell" and env.overridden("KAVOT_TEST_PIN")
    assert env.stored("KAVOT_TEST_PIN") == "file"
    env.write("KAVOT_TEST_PIN", None)


def test_older_settings_move_out_of_settings_json(client):
    from app.plugins.papers.connectors import source_settings, zotero
    settings_file = user_settings.config_dir() / "settings.json"
    payload = json.loads(settings_file.read_text(encoding="utf-8")) if settings_file.is_file() else {}
    payload["integrations"] = {"zotero": {"api_key": "zkey1234", "user_id": 42},
                               "scholarly_sources": {"crossref": {"enabled": True, "api_key": "ckey"}}}
    settings_file.write_text(json.dumps(payload), encoding="utf-8")

    assert zotero.status() == {"configured": True, "api_key_hint": "••••1234", "user_id": 42}
    assert source_settings.config("crossref")["api_key"] == "ckey"
    saved = settings_file.read_text(encoding="utf-8")
    assert "zkey1234" not in saved and "ckey" not in saved
    assert env.stored("KAVOT_ZOTERO_API_KEY") == "zkey1234" and env.stored("KAVOT_CROSSREF_API_KEY") == "ckey"

    source_settings.configure([{"id": "crossref", "clear_api_key": True}])
    assert source_settings.config("crossref")["api_key"] == ""
    env.update({"KAVOT_ZOTERO_API_KEY": None, "KAVOT_ZOTERO_USER_ID": None})
