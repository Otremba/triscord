"""Collect notices for modules actually linked into the encoded-media adapter."""
import argparse
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--go', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
source = Path(__file__).resolve().parents[1] / 'media-bridge'
wire = subprocess.check_output([args.go, 'list', '-deps', '-json', '.'], cwd=source, text=True, encoding='utf-8')
decoder = json.JSONDecoder()
modules = {}
while wire.strip():
    value, end = decoder.raw_decode(wire.lstrip())
    wire = wire.lstrip()[end:]
    module = value.get('Module', {})
    if module.get('Version'):
        modules[module['Path']] = module
out = Path(args.output)
out.mkdir(parents=True, exist_ok=True)
index = []
for name, module in sorted(modules.items()):
    directory = Path(module['Dir'])
    notices = [p for p in directory.iterdir() if p.is_file() and p.name.upper().startswith(('LICENSE', 'LICENCE', 'COPYING', 'NOTICE', 'COPYRIGHT'))]
    if not notices:
        raise SystemExit(f'Missing dependency notice: {name}')
    target = out / name.replace('/', '_')
    target.mkdir(exist_ok=True)
    for notice in notices:
        (target / notice.name).write_bytes(notice.read_bytes())
    index.append(f'{name} {module["Version"]}')
goroot = Path(subprocess.check_output([args.go, 'env', 'GOROOT'], text=True).strip())
(out / 'Go-LICENSE.txt').write_bytes((goroot / 'LICENSE').read_bytes())
(out / 'modules.txt').write_text('\n'.join(index) + '\n', encoding='utf-8')
print(f'Collected notices for {len(modules)} linked modules and the Go runtime')
