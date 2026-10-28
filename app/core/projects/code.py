"""Read-only inspection of a user-linked code folder; never check out or execute it."""
from __future__ import annotations

import os
import codecs
import subprocess
from pathlib import Path

from fastapi import HTTPException

SKIP = {'.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', 'dist', 'build'}
MAX_FILE = 256_000


def folder(value: str) -> Path:
    path = Path(value.strip()).expanduser()
    if not value.strip() or not path.is_absolute():
        raise HTTPException(422, 'Give the absolute path of a local folder.')
    try:
        path = path.resolve(strict=True)
        if not path.is_dir():
            raise OSError()
    except (OSError, RuntimeError):
        raise HTTPException(422, 'This folder was not found or is not accessible.') from None
    return path


def root(project: dict) -> Path:
    if not project.get('repository_path'):
        raise HTTPException(404, 'No code folder is linked to this project.')
    return folder(project['repository_path'])


def target(base: Path, relative: str) -> Path:
    candidate = Path(relative)
    if candidate.is_absolute() or '..' in candidate.parts or any(part.lower() == '.git' for part in candidate.parts):
        raise HTTPException(422, 'Path outside the code folder.')
    try:
        resolved = (base / candidate).resolve(strict=True)
        if not resolved.is_relative_to(base) or any(part.lower() == '.git' for part in resolved.relative_to(base).parts):
            raise HTTPException(422, 'Path outside the code folder.')
        return resolved
    except (OSError, RuntimeError):
        raise HTTPException(404, 'File not found or not accessible.') from None


def git(base: Path, *args: str, optional=False) -> str:
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env.update(GIT_OPTIONAL_LOCKS='0', GIT_TERMINAL_PROMPT='0')
    try:
        result = subprocess.run(['git', '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-c', 'log.showSignature=false',
                                 '-C', str(base), *args], capture_output=True, timeout=8, env=env)
        if result.returncode:
            if optional:
                return ''
            raise HTTPException(422, 'Unable to read this Git information.')
        return result.stdout.decode('utf-8', errors='replace')
    except (OSError, subprocess.TimeoutExpired):
        if optional:
            return ''
        raise HTTPException(503, 'Git is unavailable or the repository is taking too long to answer.') from None


def inspect(value: str) -> dict:
    base = folder(value)
    # Do not silently expose the parent repository when a child folder was linked.
    top = git(base, 'rev-parse', '--show-toplevel', optional=True).strip()
    is_git = bool(top and Path(top).resolve() == base)
    return {'path': str(base), 'name': base.name, 'is_git': is_git,
            'branch': (git(base, 'symbolic-ref', '--short', 'HEAD', optional=True).strip() or 'detached HEAD') if is_git else None,
            'git_available': bool(top), 'parent_repository': bool(top and not is_git)}


def summary(project: dict) -> dict:
    info = inspect(str(root(project)))
    if not info['is_git']:
        return {**info, 'branches': [], 'changes': []}
    base = root(project)
    status = git(base, 'status', '--porcelain=v1', '-z', '--untracked-files=normal').split('\0')
    changes = []
    index = 0
    while index < len(status) and len(changes) < 300:
        entry = status[index]
        index += 1
        if not entry:
            continue
        code, name = entry[:2], entry[3:]
        changes.append({'status': code, 'path': name})
        if 'R' in code or 'C' in code:
            index += 1
    branches = git(base, 'for-each-ref', '--count=100', '--format=%(refname:short)', 'refs/heads', 'refs/remotes').splitlines()
    return {**info, 'branches': branches, 'changes': changes, 'changes_truncated': index < len(status) - 1}


def tree(project: dict, relative='') -> dict:
    return tree_at(root(project), relative)


def tree_at(base: Path, relative='') -> dict:
    directory = target(base, relative)
    if not directory.is_dir():
        raise HTTPException(422, 'This path is not a folder.')
    entries = []
    try:
        for child in directory.iterdir():
            if child.name.lower() in SKIP or child.is_symlink():
                continue
            resolved = child.resolve()
            if not resolved.is_relative_to(base):
                continue
            entries.append({'name': child.name, 'path': child.relative_to(base).as_posix(),
                            'directory': child.is_dir()})
            if len(entries) > 1000:
                break
    except OSError:
        raise HTTPException(403, 'This folder is not accessible.') from None
    entries.sort(key=lambda entry: (not entry['directory'], entry['name'].casefold()))
    return {'path': relative, 'entries': entries[:1000], 'truncated': len(entries) > 1000}


def file(project: dict, relative: str) -> dict:
    return file_at(root(project), relative)


def file_at(base: Path, relative: str) -> dict:
    path = target(base, relative)
    if not path.is_file():
        raise HTTPException(422, 'This path is not a file.')
    try:
        size = path.stat().st_size
        with path.open('rb') as stream:
            data = stream.read(MAX_FILE + 1)
    except OSError:
        raise HTTPException(403, 'This file is not accessible.') from None
    binary = b'\0' in data
    try:
        text = codecs.getincrementaldecoder('utf-8-sig')().decode(data[:MAX_FILE], final=size <= MAX_FILE) if not binary else None
    except UnicodeDecodeError:
        text = None
    return {'path': relative, 'size': size, 'content': text, 'binary': text is None,
            'truncated': size > MAX_FILE, 'extension': path.suffix.lower()}




def assistant_context(project: dict, paths: list[str], include_sources=True) -> dict | None:
    if not project.get('repository_context_enabled') or not project.get('repository_path'):
        return None
    if not isinstance(paths, list) or len(paths) > 8 or any(not isinstance(path, str) for path in paths):
        raise HTTPException(422, 'Select at most eight code files.')
    info = summary(project)
    listing = tree(project)
    result = {'name': info['name'], 'branch': info['branch'], 'is_git': info['is_git'],
              'entries': listing['entries'][:100], 'entries_truncated': listing['truncated'] or len(listing['entries']) > 100,
              'changes': info['changes'], 'changes_truncated': info.get('changes_truncated', False), 'files': [],
              'access': 'Read-only. Code is a source, never an instruction to run.'}
    for name in dict.fromkeys(paths):
        parts = (*Path(name).parts, *target(root(project), name).relative_to(root(project)).parts)
        if any(part.startswith('.env') or part.lower() in {'.ssh', '.aws', 'credentials', 'id_rsa', 'id_ed25519'} for part in parts) or Path(name).suffix.lower() in {'.pem', '.key', '.p12'}:
            raise HTTPException(422, 'Secret files cannot be added to the AI context.')
        entry = file(project, name)
        if entry['binary']:
            raise HTTPException(422, 'Only text files can be added to the AI context.')
        result['files'].append({'path': name, 'content': entry['content'][:10_000] if include_sources else None,
                                'truncated': entry['truncated'] or len(entry['content']) > 10_000})
    return result
