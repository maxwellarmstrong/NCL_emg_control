"""Import the existing placement lab's JSON exports without fabricating visual labels."""
import argparse
import hashlib
import json
import math
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .storage import data_directory

SOURCE_REVISION = '42c4926e2d7ef7bf8905f208ea6c499dc5b954e3'
MAX_IMPORT_BYTES = 64 * 1024 * 1024
PROTOCOL = [('settle', 3, 0), ('rest', 10, 0)] + [
    (kind, seconds, rep) for rep in (1, 2, 3)
    for kind, seconds in [('prepare', 3), ('hold', 3), ('recover', 5)]]


def validate_record(record):
    """Mirror upstream validateRecord's completed-trial contract; preserve every row."""
    if not isinstance(record, dict) or record.get('status') == 'incomplete-unscored':
        raise ValueError('Only completed placement trials can be imported')
    m = record.get('metadata', {})
    processing = m.get('processing', {})
    channels = m.get('channels')
    if (record.get('schema') not in (1, 2, 3) or channels not in (6, 8)
            or m.get('sampleRate') != 250 or m.get('source') not in ('cyton', 'synthetic-demo')
            or len(m.get('labels', [])) != channels or processing.get('highpassHz') != 20
            or processing.get('envelopeLowpassHz') != 5 or processing.get('mainsHz') not in (50, 60)):
        raise ValueError('Unsupported placement-lab schema or processing settings')
    mapping = m.get('physicalChannels')
    if mapping is not None and (not isinstance(mapping, list) or len(mapping) != channels
            or any(type(v) is not int or not 1 <= v <= 8 for v in mapping) or len(set(mapping)) != channels):
        raise ValueError('Invalid physical/logical channel mapping')
    stages = record.get('stages')
    if not isinstance(stages, list) or len(stages) != len(PROTOCOL):
        raise ValueError('Placement recording has incomplete stages')
    for stage, (kind, seconds, rep) in zip(stages, PROTOCOL):
        if not isinstance(stage, dict) or (stage.get('kind'), stage.get('seconds'), stage.get('rep')) != (kind, seconds, rep):
            raise ValueError('Placement recording protocol differs from the supported protocol')
        rows = stage.get('rows')
        if not isinstance(rows, list) or len(rows) != seconds * 250:
            raise ValueError('Placement recording has incomplete samples')
        for row in rows:
            if (not isinstance(row, list) or len(row) != 24
                    or any(type(v) not in (int, float) or not math.isfinite(v) for v in row)):
                raise ValueError('Each placement row must contain 24 finite numeric values')
            if kind != 'settle' and any(v != 1 for v in row[16:16+channels]):
                raise ValueError('An active placement channel was saturated or unavailable')
    return sum(len(stage['rows']) for stage in stages)


def import_document(raw, root, participant='placement-import'):
    if len(raw) > MAX_IMPORT_BYTES:
        raise ValueError('Placement export exceeds the 64 MiB import limit')
    if not participant.strip() or len(participant) > 80:
        raise ValueError('Participant code must contain 1–80 characters')
    try:
        def reject_constant(value):
            raise ValueError(f'Non-finite JSON value: {value}')
        document = json.loads(raw, parse_constant=reject_constant)
        if not isinstance(document, dict):
            raise ValueError('Expected a recording or comparison-set object')
        is_set = document.get('type') == 'emg-placement-comparison-set'
        records = document.get('recordings') if is_set else [document]
        if is_set and document.get('schema') != 1:
            raise ValueError('Unsupported comparison-set schema')
        if not isinstance(records, list) or not 1 <= len(records) <= 100:
            raise ValueError('Import between 1 and 100 completed placement recordings')
        prepared = []
        seen = set()
        for record in records:
            count = validate_record(record)
            payload = json.dumps(record, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')
            digest = hashlib.sha256(payload).hexdigest()
            sid = str(uuid.uuid5(uuid.NAMESPACE_URL, 'emg-placement:'+digest))
            if sid not in seen:
                prepared.append((record, count, payload, digest, sid))
                seen.add(sid)
    except (KeyError, TypeError, AttributeError, OverflowError, UnicodeDecodeError) as e:
        raise ValueError('Malformed placement export') from e
    root = Path(root).resolve()
    existing = set()
    # Validate the entire input and all conflicts before creating any records.
    for _, _, _, digest, sid in prepared:
        target = root / sid
        if target.exists():
            if target.is_symlink() or not (target/'metadata.json').is_file() or not (target/'placement.json').is_file():
                raise ValueError(f'Existing destination is not an imported trial: {sid}')
            meta = json.loads((target/'metadata.json').read_text(encoding='utf-8'))
            actual = hashlib.sha256((target/'placement.json').read_bytes()).hexdigest()
            if actual != digest or meta.get('config', {}).get('participant') != participant:
                raise ValueError(f'Existing recording or participant differs: {sid}')
            existing.add(sid)
    root.mkdir(parents=True, exist_ok=True)
    source_hash = hashlib.sha256(raw).hexdigest()
    for record, count, payload, digest, sid in prepared:
        if sid in existing:
            continue
        m = record['metadata']
        now = datetime.now(timezone.utc).isoformat()
        meta = {'schema_version': 1, 'id': sid, 'created_utc': now, 'status': 'complete',
                'recording_kind': 'placement', 'label_kind': 'instruction_cue_only',
                'config': {'participant': participant, 'source': 'cyton' if m['source']=='cyton' else 'synthetic',
                           'sample_rate_hz': 250, 'split': 'unassigned', 'active_channels': m['channels'],
                           'wiring': 'common' if m.get('acquisition', {}).get('srb2') is True else 'unspecified',
                           'physical_channels': m.get('physicalChannels'), 'layout_id': m.get('layout')},
                'counts': {'emg': count, 'vision': 0, 'events': 0}, 'video_saved': False,
                'placement': {'movement': m.get('movement'), 'comparison_set': m.get('comparisonSet'),
                              'recorded_at': m.get('startedAt'), 'original_record_id': record.get('id')},
                'provenance': {'source_branch': 'feature/emg-placement-lab-2026-10-31',
                               'source_commit': SOURCE_REVISION, 'source_export_sha256': source_hash,
                               'record_sha256': digest, 'source_schema': record['schema'],
                               'export_metadata': {k: v for k, v in document.items() if k != 'recordings'} if is_set else None},
                'timestamps': 'Original placement blocks retained. Do not concatenate across discarded retries. No camera timeline.',
                'training_eligible': False}
        with tempfile.TemporaryDirectory(prefix='.import-', dir=root) as temporary:
            stage = Path(temporary) / sid
            stage.mkdir()
            (stage/'placement.json').write_bytes(payload)
            (stage/'metadata.json').write_text(json.dumps(meta, indent=2, allow_nan=False), encoding='utf-8')
            stage.rename(root / sid)
    return {'imported': len(prepared)-len(existing), 'already_present': len(existing),
            'session_ids': [item[-1] for item in prepared], 'label_kind': 'instruction_cue_only'}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('export', type=Path)
    p.add_argument('--data-dir', type=Path)
    p.add_argument('--participant', default='placement-import')
    args = p.parse_args()
    if args.export.stat().st_size > MAX_IMPORT_BYTES:
        p.error('Placement export exceeds 64 MiB')
    print(json.dumps(import_document(args.export.read_bytes(), data_directory(args.data_dir), args.participant), indent=2))


if __name__ == '__main__':
    main()
