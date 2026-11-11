# Helpers for installing Python projects that have no requirements.txt.
#   python pydeps.py          prints the dependencies in ./pyproject.toml (PEP 621 or Poetry), one per line
#   python pydeps.py --lock   prints name==version for every package in ./poetry.lock or ./uv.lock,
#                             for use as a pip constraints file (pip install -c)
import os
import re
import sys

try:
    import tomllib
except ImportError:  # Python < 3.11
    sys.exit(0)


def load(name):
    with open(name, 'rb') as f:
        return tomllib.load(f)


def poetry_version(v):
    v = str(v).strip()
    if v in ('', '*'):
        return ''
    if v[0] in '^~':
        return '>=' + v.lstrip('^~=')
    return v if re.match(r'^[<>=!]', v) else '==' + v


def dependencies():
    data = load('pyproject.toml')
    deps = list(data.get('project', {}).get('dependencies', []))
    for name, spec in data.get('tool', {}).get('poetry', {}).get('dependencies', {}).items():
        if name.lower() == 'python':
            continue
        extras = ''
        if isinstance(spec, dict):
            if spec.get('optional'):
                continue
            if spec.get('extras'):
                extras = '[' + ','.join(spec['extras']) + ']'
            spec = spec.get('version', '*')
        deps.append(name + extras + poetry_version(spec))
    return deps


def version_key(v):
    return [int(x) for x in re.findall(r'\d+', v)]


def specs(spec):
    """A Poetry dependency's version(s): "1.2", {version = "1.2"} or a list of those."""
    if isinstance(spec, list):
        return [x for item in spec for x in specs(item)]
    return [spec if isinstance(spec, str) else str(spec.get('version', ''))]


def norm(n):
    return re.sub(r'[-_.]+', '-', n).lower()


def locked():
    """
    Versions from poetry.lock or uv.lock, as pip constraints.

    Only the project's direct, pure-Python dependencies keep their locked version. Compiled ones
    (pydantic-core, jiter...) often have no build for the phone's newer Python at the locked version, so
    they're left free, and so is anything that requires one of them at an exact version.
    """
    name = next((n for n in ('poetry.lock', 'uv.lock') if os.path.exists(n)), None)
    if not name:
        return []
    data = load(name)
    old_files = data.get('metadata', {}).get('files', {})  # Poetry < 1.2 kept file lists here
    best, compiled, needs = {}, set(), {}
    for p in data.get('package', []):
        src = p.get('source') or {}
        if 'editable' in src or 'virtual' in src or 'directory' in src or 'git' in src:
            continue  # the project itself, or a package not from PyPI
        n, v = p.get('name'), p.get('version')
        if not n or not v:
            continue
        key = norm(n)
        files = [f.get('file') or f.get('url') or '' for f in p.get('files') or p.get('wheels') or []]
        files += [f.get('file', '') for f in old_files.get(n, [])]
        wheels = [f for f in files if f.endswith('.whl')]
        if files and not any(f.endswith('-none-any.whl') for f in wheels):
            compiled.add(key)
        deps = p.get('dependencies') or {}
        if isinstance(deps, dict):  # poetry: name = "spec"; only exact pins matter
            exact = [d for d, spec in deps.items() if any(re.match(r'^(==)?\d', x) for x in specs(spec))]
        else:  # uv: [{name = ...}], no specs, so treat every dependency as tied
            exact = [d.get('name', '') for d in deps]
        # A lock can list one version per Python version. Keep the newest: it's the one most
        # likely to support the phone's (recent) Python.
        if key not in best or version_key(v) > version_key(best[key][1]):
            best[key] = (n, v)
            needs[key] = {norm(d) for d in exact}
    # Only the project's own dependencies are pinned. Their version ranges keep the rest compatible,
    # and pinning everything leaves pip no room to pick compiled packages that build on this Python.
    direct = set()
    if os.path.exists('pyproject.toml'):
        direct = {norm(m.group(0)) for d in dependencies() if (m := re.match(r'[A-Za-z0-9._-]+', d))}
    return [f'{n}=={v}' for key, (n, v) in best.items()
            if key in direct and key not in compiled and not (needs[key] & compiled)]


print('\n'.join(locked() if '--lock' in sys.argv else dependencies()))
