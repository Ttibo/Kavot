from io import BytesIO
from pathlib import Path
from fastapi import HTTPException, UploadFile
from PIL import Image
from app.core.records.repository import store


def insert_pdf_crop(source: Path, filename: str, note_id: int, cursor: int, x: float, y: float, width: float, height: float):
    from app.core.workspace import documents
    from app.core.records import migrations as resources

    if x + width > 1.001 or y + height > 1.001:
        raise HTTPException(422, 'Capture outside page')
    destination = store.find('notes', note_id, 'Note')
    with Image.open(source) as image:
        left = max(0, min(image.width, round(x * image.width)))
        top = max(0, min(image.height, round(y * image.height)))
        right = max(left + 1, min(image.width, round((x + width) * image.width)))
        bottom = max(top + 1, min(image.height, round((y + height) * image.height)))
        output = BytesIO()
        image.crop((left, top, right, bottom)).save(output, format="PNG")
    output.seek(0)
    capture = resources.import_file(
        UploadFile(filename=filename, file=output),
        project_id=destination.get('project_id'), note_id=note_id,
    )
    with store.batch():
        note = store.find("notes", note_id, "Note")
        content = documents.enrich_note(note, store.read()).get('content', '')
        from app.core.workspace.html_documents import insert
        content = insert(content, capture['markdown'], cursor)
        saved = documents.update_note(note_id, type("NotePatch", (), {"model_dump": lambda self, **_: {"content": content}})())
    content = saved['content']
    end = len(content)
    return {**capture, "content": content, "note": saved, "insertion_end": len(content[:end].encode('utf-16-le')) // 2}

