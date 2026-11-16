"""Portable local archives shared by acquisition and placement-lab recordings."""
import argparse
import hashlib
import json
import os
import shutil
import tempfile
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SESSION_FILES = ('metadata.json', 'emg.jsonl', 'vision.jsonl', 'events.jsonl', 'placement.json')
CHUNK = 1024 * 1024


def data_directory(value=None):
    return Path(value or os.environ.get('EMG_DATA_DIR') or ROOT / 'data/sessions').expanduser().resolve()


def completed_sessions(root):
    return [p.parent for p in sorted(Path(root).glob('*/metadata.json'))
            if json.loads(p.read_text(encoding='utf-8'))['status'] == 'complete']


def archive_name(name):
    parts = name.split('/')
    if len(parts) != 2 or parts[1] not in SESSION_FILES:
        raise ValueError(f'Unexpected archive member: {name}')
    try:
        if str(uuid.UUID(parts[0])) != parts[0]:
            raise ValueError()
    except ValueError as e:
        raise ValueError('Archive session names must be canonical UUIDs') from e
    return parts


def create_archive(folders, output):
    """Stream files into a new ZIP; never replace an existing backup."""
    folders, output = list(folders), Path(output)
    if not folders:
        raise ValueError('No completed sessions to back up')
    manifest = {'schema_version': 1, 'created_utc': datetime.now(timezone.utc).isoformat(),
                'files': {}, 'privacy': 'Contains local research recordings; choose a private backup destination.'}
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('xb') as destination:
        try:
            with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
                for folder in folders:
                    for filename in SESSION_FILES:
                        path = folder / filename
                        if not path.exists():
                            continue
                        if path.is_symlink() or folder.is_symlink():
                            raise ValueError('Recording archives cannot include symbolic links')
                        name = f'{folder.name}/{filename}'
                        archive_name(name)
                        if name in manifest['files']:
                            raise ValueError('Duplicate session in archive')
                        digest, size = hashlib.sha256(), 0
                        with path.open('rb') as source, archive.open(name, 'w', force_zip64=True) as member:
                            while chunk := source.read(CHUNK):
                                digest.update(chunk)
                                size += len(chunk)
                                member.write(chunk)
                        manifest['files'][name] = {'bytes': size, 'sha256': digest.hexdigest()}
                archive.writestr('manifest.json', json.dumps(manifest, indent=2))
        except Exception:
            destination.close()
            output.unlink()  # Only this newly-created, incomplete archive.
            raise
    return manifest


def verify_archive(path):
    """Validate all paths and streamed hashes before permitting any restoration."""
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or len(names) > 50000:
            raise ValueError('Duplicate or excessive archive entries')
        if 'manifest.json' not in names or archive.getinfo('manifest.json').file_size > 10 * CHUNK:
            raise ValueError('Missing or oversized manifest')
        manifest = json.loads(archive.read('manifest.json'))
        files = manifest.get('files')
        if manifest.get('schema_version') != 1 or not isinstance(files, dict) or not files:
            raise ValueError('Unsupported archive manifest')
        if set(names) != {'manifest.json', *files}:
            raise ValueError('Archive and manifest members differ')
        if sum(archive.getinfo(name).file_size for name in files) > 64 * 1024**3:
            raise ValueError('Archive exceeds the 64 GiB restore limit')
        for name, expected in files.items():
            sid, _ = archive_name(name)
            if f'{sid}/metadata.json' not in files:
                raise ValueError('Session metadata is missing')
            digest, size = hashlib.sha256(), 0
            with archive.open(name) as source:
                while chunk := source.read(CHUNK):
                    digest.update(chunk)
                    size += len(chunk)
            if size != expected.get('bytes') or digest.hexdigest() != expected.get('sha256'):
                raise ValueError(f'Checksum mismatch: {name}')
            if name.endswith('/metadata.json'):
                if size > 2 * CHUNK:
                    raise ValueError('Session metadata is too large')
                metadata = json.loads(archive.read(name))
                if metadata.get('id') != sid or metadata.get('status') not in ('complete', 'recording', 'interrupted'):
                    raise ValueError('Session metadata does not match archive')
    return manifest


def restore_archive(archive_path, root):
    manifest = verify_archive(archive_path)
    root = Path(root).resolve()
    ids = sorted({archive_name(name)[0] for name in manifest['files']})
    existing = set()
    # Preflight every conflict before writing any sessions. Never overwrite local data.
    for sid in ids:
        target = root / sid
        if not target.exists():
            continue
        if target.is_symlink() or not target.is_dir():
            raise ValueError(f'Unsafe restore destination: {sid}')
        expected_names = {n.split('/')[1] for n in manifest['files'] if n.startswith(sid+'/')}
        if {p.name for p in target.iterdir() if p.is_file()} != expected_names:
            raise ValueError(f'Existing recording differs: {sid}')
        for filename in expected_names:
            path = target / filename
            if path.is_symlink():
                raise ValueError(f'Unsafe restore destination: {sid}')
            with path.open('rb') as source:
                digest = hashlib.file_digest(source, 'sha256').hexdigest()
            if digest != manifest['files'][f'{sid}/{filename}']['sha256']:
                raise ValueError(f'Existing recording differs: {sid}')
        existing.add(sid)
    root.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive_path) as archive:
        for sid in ids:
            if sid in existing:
                continue
            with tempfile.TemporaryDirectory(prefix='.restore-', dir=root) as temporary:
                stage = Path(temporary) / sid
                stage.mkdir()
                for name in manifest['files']:
                    if name.startswith(sid+'/'):
                        with archive.open(name) as source, (stage / name.split('/')[1]).open('xb') as dest:
                            shutil.copyfileobj(source, dest, CHUNK)
                stage.rename(root / sid)
    return {'restored': len(ids)-len(existing), 'already_present': len(existing)}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    commands = p.add_subparsers(dest='command', required=True)
    backup = commands.add_parser('backup')
    backup.add_argument('--data-dir', type=Path)
    backup.add_argument('--output', type=Path, required=True)
    verify = commands.add_parser('verify')
    verify.add_argument('archive', type=Path)
    restore = commands.add_parser('restore')
    restore.add_argument('archive', type=Path)
    restore.add_argument('--data-dir', type=Path)
    args = p.parse_args()
    if args.command == 'backup':
        root = data_directory(args.data_dir)
        manifest = create_archive(completed_sessions(root), args.output)
        print(json.dumps({'archive': str(args.output.resolve()), 'files': len(manifest['files'])}))
    elif args.command == 'verify':
        print(json.dumps({'verified_files': len(verify_archive(args.archive)['files'])}))
    else:
        print(json.dumps(restore_archive(args.archive, data_directory(args.data_dir))))


if __name__ == '__main__':
    main()
