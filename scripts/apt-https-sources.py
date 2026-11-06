#!/usr/bin/env python3
"""Upgrade only official Ubuntu APT source URIs on the hosted Linux runner."""
import os
import re
import stat

URI = re.compile(r'http://(?:azure\.archive\.ubuntu\.com|archive\.ubuntu\.com|security\.ubuntu\.com)/ubuntu/?\Z')
NAMES = {'sources.list', 'ubuntu.sources', 'apt-mirrors.txt'}
MAX_BYTES = 1024 * 1024


def owned_directory(name, parent=None):
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        directory_custody(fd)
        return fd
    except BaseException:
        os.close(fd)
        raise


def directory_custody(fd):
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
        raise ValueError('unsafe APT source directory')


def identity(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def convert(text):
    def upgrade(uri):
        return 'https://' + uri[7:] if URI.fullmatch(uri) else uri

    result = []
    in_uris = False
    for line in text.splitlines(keepends=True):
        if re.match(r'^URIs:', line, re.I):
            in_uris = True
            prefix, values = line.split(':', 1)
            line = prefix + ':' + re.sub(r'\S+', lambda m: upgrade(m.group()), values)
        elif in_uris and re.match(r'^[ \t]+\S', line):
            line = re.sub(r'\S+', lambda m: upgrade(m.group()), line)
        else:
            in_uris = False
            match = re.match(r'^(\s*deb(?:-src)?\s+(?:\[[^\]\n]*\]\s+)?)(\S+)', line)
            if match:
                line = line[:match.start(2)] + upgrade(match.group(2)) + line[match.end(2):]
        result.append(line)
    return ''.join(result)


def convert_mirrors(text):
    # Hosted images use mirror+file: indirection. Keep the mirror selection,
    # priority/options and existing HTTPS entries; change only approved schemes.
    result = []
    for line in text.splitlines(keepends=True):
        match = re.match(r'^[ \t]*(\S+)', line)
        if match and URI.fullmatch(match.group(1)):
            line = line[:match.start(1)] + 'https://' + match.group(1)[7:] + line[match.end(1):]
        result.append(line)
    return ''.join(result)


def update_file(directory_fd, name):
    if name not in NAMES:
        raise ValueError('unexpected APT source filename')
    directory_custody(directory_fd)
    try:
        fd = os.open(name, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
    except FileNotFoundError:
        return
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or
                info.st_uid != os.geteuid() or info.st_mode & 0o022 or info.st_size > MAX_BYTES):
            raise ValueError('unsafe APT source file')
        raw = os.read(fd, MAX_BYTES + 1)
        if len(raw) > MAX_BYTES or len(raw) != info.st_size:
            raise ValueError('APT source size changed while reading')
        conversion = convert_mirrors if name == 'apt-mirrors.txt' else convert
        updated = conversion(raw.decode('utf-8')).encode('utf-8')
        if len(updated) > MAX_BYTES:
            raise ValueError('updated APT source exceeds its bound')
        if updated != raw:
            directory_custody(directory_fd)
            current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            if identity(os.fstat(fd)) != identity(info) or identity(current) != identity(info):
                raise ValueError('APT source custody changed before writing')
            os.lseek(fd, 0, os.SEEK_SET)
            offset = 0
            while offset < len(updated):
                written = os.write(fd, updated[offset:])
                if written <= 0:
                    raise ValueError('APT source write made no progress')
                offset += written
            os.ftruncate(fd, len(updated))
            os.fsync(fd)
    finally:
        os.close(fd)


def main():
    # Open fixed directories without following symlinks; never accept a path argument.
    root = owned_directory('/')
    try:
        etc = owned_directory('etc', root)
        try:
            apt = owned_directory('apt', etc)
            try:
                update_file(apt, 'apt-mirrors.txt')
                update_file(apt, 'sources.list')
                try:
                    sources = owned_directory('sources.list.d', apt)
                except FileNotFoundError:
                    return
                try:
                    update_file(sources, 'ubuntu.sources')
                finally:
                    os.close(sources)
            finally:
                os.close(apt)
        finally:
            os.close(etc)
    finally:
        os.close(root)


if __name__ == '__main__':
    main()
