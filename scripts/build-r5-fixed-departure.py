#!/usr/bin/env python3
"""Build an explicitly patched R5 v7.4-r5py JAR for fixed-departure itineraries.

Fixes departure-time selection and provides a native dominance-list factory.
Zero tolerance uses indexed dominance with the same accepted states and order.
Street search, McRAPTOR rounds and boarding slack are preserved. The factory
avoids crossing into Python for every state bag. The original JAR is kept.
"""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile

SOURCE = 'https://raw.githubusercontent.com/r5py/r5/v7.4-r5py/src/main/java/com/conveyal/r5/profile/McRaptorSuboptimalPathProfileRouter.java'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('original', type=Path)
parser.add_argument('output', type=Path)
parser.add_argument('--javac', default='javac')
parser.add_argument('--java', help='Java runtime matching javac (defaults to its sibling)')
args = parser.parse_args()
if args.original.resolve() == args.output.resolve():
    parser.error('output must preserve the original JAR')
source = urllib.request.urlopen(SOURCE).read().decode()
old = '''        while(departureTimes.size() != request.monteCarloDraws){
            departureTimes = generateDepartureTimesToSample(request);
        }'''
new = '''        if (request.fromTime == request.toTime) {
            departureTimes.add(request.fromTime);
        } else {
            if (request.monteCarloDraws <= 0 ||
                request.toTime - request.fromTime < 2 * request.monteCarloDraws) {
                throw new IllegalArgumentException("Departure sampling step must be positive");
            }
            while (departureTimes.size() != request.monteCarloDraws) {
                departureTimes = generateDepartureTimesToSample(request);
            }
        }'''
assert source.count(old) == 1, 'Pinned R5 source no longer matches the patch'
source = source.replace(old, new).replace(
    'public class McRaptorSuboptimalPathProfileRouter {',
    '''public class McRaptorSuboptimalPathProfileRouter {
    public static final boolean VIGO_BENCH_FIXED_DEPARTURE = true;
    public static final String VIGO_BENCH_DOMINANCE = "zero-tolerance-index-v1";
    public static IntFunction<DominatingList> createSuboptimalListSupplier(int minutes) {
        return ignored -> minutes == 0 ? new ZeroToleranceDominatingList() : new SuboptimalDominatingList(minutes);
    }

    /** Zero-tolerance dominance for this pinned router, preserving states/order.
     *  Router consumers only read/copy the returned list, and state time, round
     *  and accessMode are immutable after insertion. The index requires this
     *  internal invariant; it is not a general mutable DominatingList adapter.
     */
    static class ZeroToleranceDominatingList implements DominatingList {
        private final List<McRaptorState> states = new ArrayList<>();
        private final Map<LegMode, Integer> minRoundByMode = new HashMap<>();
        private int bestTime = Integer.MAX_VALUE;

        public boolean add(McRaptorState state) {
            if (state.time > bestTime) return false;
            if (state.time < bestTime) {
                states.clear();
                minRoundByMode.clear();
                bestTime = state.time;
            }
            Integer minRound = minRoundByMode.get(state.accessMode);
            if (minRound != null && minRound < state.round) return false;
            if (minRound != null && state.round < minRound) {
                states.removeIf(old -> old.accessMode == state.accessMode);
            }
            minRoundByMode.put(state.accessMode, state.round);
            states.add(state);
            return true;
        }

        public Collection<McRaptorState> getNonDominatedStates() {
            return states;
        }
    }''')
with tempfile.TemporaryDirectory(prefix='r5-fixed-departure-') as temporary:
    root = Path(temporary)
    java = root / 'McRaptorSuboptimalPathProfileRouter.java'
    java.write_text(source)
    subprocess.run([args.javac, '--release', '21', '-cp', str(args.original.resolve()), '-d', str(root), str(java)], check=True)
    replacements = {str(p.relative_to(root)): p.read_bytes() for p in root.rglob('*.class')}
    candidate = root / 'r5-itineraries.jar'
    with zipfile.ZipFile(args.original) as original, zipfile.ZipFile(candidate, 'w') as output:
        for entry in original.infolist():
            output.writestr(entry, replacements.pop(entry.filename, original.read(entry)))
        for name, data in replacements.items():
            output.writestr(name, data)
        output.writestr('vigo-bench-fixed-departure.java.txt', source)
    # Compare the optimized factory against the untouched upstream class in
    # this very JAR before making the requested runtime available to a run.
    test = Path(__file__).resolve().parents[1] / 'test/R5ZeroToleranceParity.java'
    subprocess.run([args.javac, '--release', '21', '-cp', str(candidate), '-d', str(root), str(test)], check=True)
    java_runtime = args.java or str(Path(shutil.which(args.javac) or args.javac).with_name('java'))
    subprocess.run([java_runtime, '-cp', str(candidate) + os.pathsep + str(root),
                    'com.conveyal.r5.profile.R5ZeroToleranceParity'], check=True)
    shutil.copyfile(candidate, args.output)
print(args.output)
