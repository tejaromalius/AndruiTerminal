#!/usr/bin/env python3
"""Audit the implementation ledger (docs/FEATURE_COVERAGE.md): IDs, evidence and catalog mapping."""
import argparse
from collections import Counter
import json
from pathlib import Path
import re
import sys
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
ROW = re.compile(r'^\| ((?:C|E|F|P|D|V|N|X)\d{2}) \|', re.MULTILINE)
# The ledger is the source of truth; this guards against rows being dropped or added by accident.
EXPECTED_IDS = 164


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', help='Optional running application base URL to inspect its operation catalog')
    parser.add_argument('--require-complete', action='store_true')
    args = parser.parse_args()
    lines = (ROOT / 'docs/FEATURE_COVERAGE.md').read_text().splitlines()
    rows = {}
    errors = []
    for line in lines:
        match = ROW.match(line)
        if not match:
            continue
        fields = [v.strip() for v in line.split('|')[1:-1]]
        key = match.group(1)
        if key in rows:
            errors.append('Duplicate ledger ID ' + key)
        rows[key] = {'state': fields[2], 'owner': fields[3], 'evidence': fields[4]}
    source_ids = set(rows)
    if len(source_ids) != EXPECTED_IDS:
        errors.append(f'Ledger has {len(source_ids)} requirement IDs, expected {EXPECTED_IDS}')
    for key, row in rows.items():
        if row['state'].lower() in ['implemented', 'verified'] and row['evidence'].lower() in ['', 'not verified', 'none', 'pending']:
            errors.append(key + ' claims implementation without evidence')
    result = {'requirements': len(source_ids), 'states': dict(Counter(row['state'] for row in rows.values())), 'errors': errors}
    if args.url:
        with urllib.request.urlopen(args.url.rstrip('/') + '/api/v1/operations', timeout=10) as response:
            operations = json.load(response)
        mapped = {}
        for operation in operations:
            for key in operation.get('coverageIds', []):
                mapped.setdefault(key, []).append(operation['id'])
        result['operations'] = len(operations)
        result['catalogMappedIds'] = len(source_ids.intersection(mapped))
        result['catalogUnmappedIds'] = sorted(source_ids - set(mapped))
        result['unknownCatalogIds'] = sorted(set(mapped) - source_ids)
        result['note'] = 'Catalog mappings establish discoverability, not execution or verified feature parity.'
        if result['unknownCatalogIds']:
            errors.append('Unknown requirement IDs in catalog')
    if args.require_complete:
        unfinished = [key for key,row in rows.items() if row['state'].lower() not in ['implemented','verified','conditional','not applicable']]
        if unfinished:
            errors.append('Unfinished requirements: ' + ', '.join(sorted(unfinished)))
    print(json.dumps(result, indent=2))
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
