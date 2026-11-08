#!/usr/bin/env python3
"""Narrow, operator-reviewed incident ingress configuration. Never installs sudo policy."""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
from urllib.parse import urlsplit

CONFIG = Path('/etc/hail-monitor-enrollment')


def prepare(caddy, override, origin):
    parsed = urlsplit(origin)
    if (parsed.scheme != 'https' or parsed.netloc != parsed.hostname or parsed.path or parsed.query or parsed.fragment
            or not re.fullmatch(r'[a-z0-9]+(?:[.-][a-z0-9]+)+', parsed.hostname or '')):
        raise ValueError('Use a canonical HTTPS DNS origin without a port')
    # Only an already-tunneled enrollment hostname; never open another host here.
    if not re.search(r'\bhost\s+' + re.escape(parsed.hostname) + r'\s', caddy):
        raise ValueError('Origin is not the existing enrolled tunnel hostname')
    if 'monitor_incidents' in caddy:
        raise ValueError('Incident ingress already configured; inspect existing configuration')
    marker = '  handle @tunnel_provider {'
    if caddy.count(marker) != 1 or 'path /api/v1/onboarding /api/v1/onboarding/stop' not in caddy:
        raise ValueError('Unexpected ingress configuration; review manually')
    addition = f'''  # Public incident UI; enrollment source restrictions remain separate.
  @monitor_incidents {{
    host {parsed.hostname}
    method GET POST
    path /incidents/*
  }}
  handle @monitor_incidents {{
    reverse_proxy 127.0.0.1:3001
  }}
'''
    updated = caddy.replace(marker, addition + marker)
    result = json.loads(json.dumps(override))
    environment = result['services']['monitor'].setdefault('environment', {})
    if not isinstance(environment, dict):
        raise ValueError('Expected an environment map')
    environment['MONITOR_INCIDENT_ORIGIN'] = origin
    return updated, result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--origin', required=True)
    flags = parser.add_mutually_exclusive_group(required=True)
    flags.add_argument('--check', action='store_true')
    flags.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    caddy_path, compose_path = CONFIG / 'Caddyfile', CONFIG / 'compose.override.json'
    caddy, compose = prepare(caddy_path.read_text(), json.loads(compose_path.read_text()), args.origin)
    print(json.dumps({'origin': args.origin, 'publicPaths': '/incidents/*', 'methods': ['GET', 'POST'],
                      'preserved': ['provider enrollment admission', 'database overlay', 'ports', 'tunnel', 'sudo policy']}))
    if not args.apply:
        return
    if os.geteuid() != 0:
        raise ValueError('Apply requires reviewed existing privileged access')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    candidate = CONFIG / ('Caddyfile.incidents-' + stamp)
    fd = os.open(candidate, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w') as output:
        output.write(caddy)
    try:
        subprocess.run(['docker', 'run', '--rm', '--network', 'none', '--mount',
                        f'type=bind,src={candidate},dst=/etc/caddy/Caddyfile,readonly',
                        'caddy:2.10.2-alpine', 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile'], check=True)
        for path in (caddy_path, compose_path):
            backup = path.with_name(path.name + '.before-incidents-' + stamp)
            if backup.exists():
                raise ValueError('Backup already exists')
            shutil.copy2(path, backup)
            os.chmod(backup, 0o600)
        # Keep the Caddyfile inode: it is an existing container bind mount.
        try:
            caddy_path.write_text(caddy)
            compose_path.write_text(json.dumps(compose, indent=2) + '\n')
        except Exception:
            for path in (caddy_path, compose_path):
                path.write_bytes(path.with_name(path.name + '.before-incidents-' + stamp).read_bytes())
            raise
        print('Configuration saved. Recreate only monitor with all existing overlays, then restart enrollment-edge. Verify before sending capability links.')
    finally:
        candidate.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
