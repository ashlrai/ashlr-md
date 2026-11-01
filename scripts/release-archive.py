"""Verify and safely unpack one *original* Actions artifact ZIP locally.

The expected digest must come from an authenticated GitHub API response, not
from a caller's assertion about the archive. This module does not fetch it.
"""
import hashlib
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tempfile
import unicodedata
import zipfile

MAX_ZIP = 2 * 1024**3
MAX_FILE = 2 * 1024**3
MAX_TOTAL = 4 * 1024**3
MAX_ENTRIES = 100_000
MAX_DIRECTORY = 32 * 1024**2
MAX_RATIO = 1000


def _fail(message):
    raise ValueError(message)


def _validate(info):
    name = info.orig_filename
    if name != info.filename or not name or '\\' in name or '\x00' in name:
        _fail('invalid ZIP entry name')
    directory = info.is_dir()
    path = name[:-1] if directory else name
    if (not path or path.startswith('/') or ':' in path
            or any(part in ('', '.', '..') for part in path.split('/'))):
        _fail(f'unsafe ZIP entry path: {name!r}')
    if any(ord(c) < 32 or ord(c) == 127 for c in path):
        _fail('control character in ZIP path')
    mode = info.external_attr >> 16
    kind = stat.S_IFMT(mode)
    if kind not in (0, stat.S_IFDIR if directory else stat.S_IFREG):
        _fail(f'non-regular ZIP entry: {name!r}')
    if info.flag_bits & 1:
        _fail('encrypted ZIP entries are not supported')
    if info.file_size > MAX_FILE or info.file_size < 0 or info.compress_size < 0:
        _fail('ZIP entry size exceeds limit')
    if directory and info.file_size:
        _fail('non-empty ZIP directory')
    if info.file_size and (not info.compress_size or info.file_size > MAX_RATIO * info.compress_size):
        _fail('ZIP entry compression ratio exceeds limit')
    return path


def unpack_verified(zip_path, expected_digest, dest):
    """Verify sha256:<hex>, then extract safely to a new directory.

    Returns a deterministic dict of regular member names to SHA-256 hashes.
    Archive bytes are copied into a private file while hashing, and only the
    verified private copy is parsed; no archive link is materialized.
    """
    zip_path, dest = Path(zip_path), Path(dest)
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', expected_digest):
        _fail('missing or malformed API SHA-256 digest')
    if dest.exists() or dest.is_symlink():
        _fail('destination already exists')
    if zip_path.is_symlink() or not zip_path.is_file():
        _fail('artifact ZIP must be a regular non-symlink file')
    if not dest.parent.is_dir():
        _fail('destination parent is missing')
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
    with os.fdopen(os.open(zip_path, flags), 'rb') as source, tempfile.TemporaryFile(dir=dest.parent) as archive_file:
        source_stat = os.fstat(source.fileno())
        if not stat.S_ISREG(source_stat.st_mode) or source_stat.st_size > MAX_ZIP:
            _fail('artifact ZIP is not a bounded regular file')
        h = hashlib.sha256()
        copied = 0
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            copied += len(chunk)
            if copied > MAX_ZIP: _fail('artifact ZIP exceeds size limit')
            h.update(chunk)
            archive_file.write(chunk)
        if h.hexdigest() != expected_digest[7:]:
            _fail('artifact ZIP digest mismatch')
        # zipfile loads the complete central directory during construction.
        # Preflight its own ZIP64-aware end-record parser before allocating it.
        archive_file.seek(0)
        end = zipfile._EndRecData(archive_file)
        if end is None: _fail('invalid ZIP end record')
        if end[zipfile._ECD_ENTRIES_TOTAL] > MAX_ENTRIES: _fail('too many ZIP entries')
        if end[zipfile._ECD_SIZE] > MAX_DIRECTORY: _fail('ZIP central directory exceeds limit')
        archive_file.seek(0)
        with zipfile.ZipFile(archive_file) as archive:
            items = archive.infolist()
            if len(items) > MAX_ENTRIES:
                _fail('too many ZIP entries')
            total = 0
            # Case and Unicode collisions are rejected even on a case-sensitive
            # host; parent/file conflicts are rejected before any extraction.
            seen = {}
            spellings = {}
            files = set()
            entries = []
            for info in items:
                path = _validate(info)
                key = unicodedata.normalize('NFC', path).casefold()
                components = path.split('/')
                for i in range(1, len(components) + 1):
                    spelling = '/'.join(components[:i])
                    folded = unicodedata.normalize('NFC', spelling).casefold()
                    if folded in spellings and spellings[folded] != spelling:
                        _fail('ambiguous ZIP path component')
                    spellings[folded] = spelling
                if key in seen:
                    _fail('duplicate or ambiguous ZIP entry')
                seen[key] = info.is_dir()
                if not info.is_dir(): files.add(key)
                total += info.file_size
                if total > MAX_TOTAL: _fail('ZIP total size exceeds limit')
                entries.append((path, key, info))
            for path, key, info in entries:
                pieces = key.split('/')
                if any('/'.join(pieces[:i]) in files for i in range(1, len(pieces))):
                    _fail('ZIP file/directory collision')
            # Exclusive creation prevents a concurrent process from making us
            # replace an existing destination. Keep it private until complete.
            dest.mkdir(mode=0o700)
            completed = False
            try:
                hashes = {}
                for path, _, info in sorted(entries, key=lambda x: x[0]):
                    target = dest.joinpath(*PurePosixPath(path).parts)
                    if info.is_dir():
                        target.mkdir(parents=True, exist_ok=True, mode=0o700)
                        continue
                    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    h = hashlib.sha256()
                    count = 0
                    with archive.open(info) as source, target.open('xb') as out:
                        os.chmod(target, 0o600)
                        while True:
                            chunk = source.read(1024 * 1024)
                            if not chunk: break
                            count += len(chunk)
                            if count > info.file_size or count > MAX_FILE:
                                _fail('ZIP entry exceeded declared size')
                            h.update(chunk)
                            out.write(chunk)
                    if count != info.file_size:
                        _fail('ZIP entry length mismatch')
                    hashes[path] = h.hexdigest()
                completed = True
                return hashes
            finally:
                if not completed: shutil.rmtree(dest)
