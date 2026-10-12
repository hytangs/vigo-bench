#!/usr/bin/env python3
"""Build the directed ULTRA reducer without changing the upstream checkout."""

import argparse
import json
import os
from pathlib import Path
import platform
import shlex
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]


def capture(command, **kwargs):
    return subprocess.check_output(command, text=True, **kwargs).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('checkout', type=Path, nargs='?', default=ROOT / '.engine-tools/ultra')
    parser.add_argument('output', type=Path, nargs='?',
                        default=ROOT / '.engine-tools/ultra/cmake-build-release2/Network-directed')
    args = parser.parse_args()
    checkout, output = args.checkout.resolve(), args.output.resolve()
    compiler = os.environ.get('CXX')
    flags = ['-std=c++23', '-march=native', '-fopenmp']
    if platform.system() == 'Darwin':
        brew = shutil.which('brew')
        if not brew:
            parser.error('Homebrew LLVM and libomp are required on macOS.')
        if not compiler:
            for formula in ('llvm', 'llvm@22'):
                prefix = subprocess.run([brew, '--prefix', formula], capture_output=True, text=True)
                candidate = Path(prefix.stdout.strip()) / 'bin/clang++'
                if prefix.returncode == 0 and candidate.is_file():
                    compiler = str(candidate)
                    break
        omp = capture([brew, '--prefix', 'libomp'])
        flags += [f'-I{omp}/include', f'-L{omp}/lib', f'-Wl,-rpath,{omp}/lib']
    compiler = compiler or shutil.which('g++')
    if not compiler:
        parser.error('Set CXX to a compiler supporting C++23 and OpenMP.')
    revision = capture(['git', '-C', str(checkout), 'rev-parse', 'HEAD'])
    source_diff = capture(['git', '-C', str(checkout), 'diff', 'HEAD', '--'])
    patch = ROOT / 'scripts/patches/ultra-directed-reduction.patch'
    output.parent.mkdir(parents=True, exist_ok=True)
    commands = []
    with tempfile.TemporaryDirectory(prefix='ultra-directed-', dir=output.parent) as directory:
        work = Path(directory)
        source = work / 'source'
        # Copy tracked working-tree sources, including the existing platform fixes.
        # Graphs, binaries and the original checkout are never changed.
        files = capture(['git', '-C', str(checkout), 'ls-files', '-z']).split('\0')
        for name in files:
            original = checkout / name
            if original.is_file():
                target = source / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(original, target)
        apply = ['git', 'apply', '--unsafe-paths', f'--directory={source}', str(patch)]
        already_applied = subprocess.run(apply[:2] + ['--reverse', '--check'] + apply[2:],
                                        capture_output=True).returncode == 0
        if not already_applied:
            subprocess.run(apply[:2] + ['--check'] + apply[2:], check=True)
            subprocess.run(apply, check=True)
        prefix = shlex.split(compiler) + flags + [f'-I{source}']
        validation = work / 'test-directed-reduction'
        commands.append(prefix + ['-O1', '-g', '-fsanitize=address,undefined',
                                  str(ROOT / 'test/ultra_directed_reduction.cpp'), '-o', str(validation)])
        subprocess.run(commands[-1], check=True)
        commands.append([str(validation)])
        with (work / 'validation.log').open('w') as log:
            subprocess.run(commands[-1], check=True, stdout=subprocess.DEVNULL, stderr=log)
        binary = work / 'Network-directed'
        commands.append(prefix + ['-O3', '-DNDEBUG', '-ffast-math',
                                  str(source / 'Runnables/Network.cpp'), '-o', str(binary)])
        subprocess.run(commands[-1], check=True)
        binary.replace(output)
        shutil.copy2(work / 'validation.log', str(output) + '.validation.log')
    Path(str(output) + '.source.patch').write_text(source_diff + '\n')
    Path(str(output) + '.build.json').write_text(json.dumps({
        'source': str(checkout), 'revision': revision, 'patch': str(patch),
        'patchAlreadyApplied': already_applied, 'compiler': compiler,
        'compilerVersion': capture(shlex.split(compiler) + ['--version']),
        'commands': commands, 'validation': '24576 directed graphs; ASan and UBSan',
    }, indent=2) + '\n')
    print(f'Built {output}')


if __name__ == '__main__':
    main()
