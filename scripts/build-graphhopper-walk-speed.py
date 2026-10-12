#!/usr/bin/env python3
"""Expose GraphHopper's existing walking-speed request option over HTTP.

Compile one resource class against the pinned JAR, preserving the original
JAR and checkout. Retain the exact patched source inside the output archive.
"""
import argparse
from pathlib import Path
import subprocess
import tempfile
import zipfile


def patched_source(source):
    edits = [
        ('@QueryParam("pt.algorithm") String algorithm)',
         '@QueryParam("pt.walk_speed") Double walkSpeed,\n                            @QueryParam("pt.algorithm") String algorithm)'),
        ('request.setArriveBy(arriveBy);',
         'request.setArriveBy(arriveBy);\n        if (walkSpeed != null) {\n'
         '            if (!Double.isFinite(walkSpeed) || walkSpeed <= 0)\n'
         '                throw new IllegalArgumentException("pt.walk_speed must be positive and finite");\n'
         '            request.setWalkSpeedKmH(walkSpeed);\n        }'),
    ]
    for old, new in edits:
        if source.count(old) != 1:
            raise ValueError(f"Pinned GraphHopper source mismatch: {old}")
        source = source.replace(old, new)
    return source


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('original', type=Path)
    parser.add_argument('checkout', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    if args.original.resolve() == args.output.resolve():
        parser.error('output must preserve the original JAR')
    source = patched_source((args.checkout / 'web-bundle/src/main/java/com/graphhopper/resources/PtRouteResource.java').read_text())
    with tempfile.TemporaryDirectory(prefix='graphhopper-walk-speed-') as directory:
        root = Path(directory)
        java = root / 'PtRouteResource.java'
        java.write_text(source)
        subprocess.run(['javac', '-proc:none', '-cp', str(args.original.resolve()), '-d', str(root), str(java)], check=True)
        name = 'com/graphhopper/resources/PtRouteResource.class'
        candidate = root / 'patched.jar'
        with zipfile.ZipFile(args.original) as original, zipfile.ZipFile(candidate, 'w', zipfile.ZIP_DEFLATED) as output:
            for entry in original.infolist():
                if entry.filename != name:
                    output.writestr(entry, original.read(entry.filename))
            output.write(root / name, name)
            output.writestr('vigo-bench-walk-speed-v1.java.txt', source)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        import shutil
        shutil.copyfile(candidate, args.output)
    print(args.output)


if __name__ == '__main__':
    main()
