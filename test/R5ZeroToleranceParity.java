package com.conveyal.r5.profile;

import com.conveyal.r5.api.util.LegMode;
import com.conveyal.r5.profile.McRaptorSuboptimalPathProfileRouter.McRaptorState;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Random;

/** Compare every accepted/rejected insertion and state identity/order to upstream. */
public class R5ZeroToleranceParity {
    private static long insertions;
    private static long sequences;

    private static McRaptorState state(int time, int round, LegMode mode) {
        McRaptorState state = new McRaptorState();
        state.time = time;
        state.round = round;
        state.accessMode = mode;
        return state;
    }

    private static void compare(List<McRaptorState> sequence) {
        DominatingList original = new SuboptimalDominatingList(0);
        DominatingList indexed = McRaptorSuboptimalPathProfileRouter.createSuboptimalListSupplier(0).apply(0);
        for (McRaptorState state : sequence) {
            boolean before = original.add(state);
            boolean after = indexed.add(state);
            if (before != after || !new ArrayList<>(original.getNonDominatedStates()).equals(
                    new ArrayList<>(indexed.getNonDominatedStates()))) {
                throw new AssertionError("Acceptance or state order mismatch at insertion " + insertions);
            }
            insertions++;
        }
        sequences++;
    }

    private static void enumerate(List<McRaptorState> states, McRaptorState[] sequence, int position) {
        if (position == sequence.length) {
            compare(Arrays.asList(sequence));
            return;
        }
        for (McRaptorState state : states) {
            sequence[position] = state;
            enumerate(states, sequence, position + 1);
        }
    }

    public static void main(String[] args) {
        List<McRaptorState> ordinary = new ArrayList<>();
        for (int time : new int[]{-1, 0, 1})
            for (int round : new int[]{0, 1})
                for (LegMode mode : new LegMode[]{null, LegMode.WALK, LegMode.CAR})
                    ordinary.add(state(time, round, mode));
        enumerate(ordinary, new McRaptorState[4], 0);
        List<McRaptorState> edges = new ArrayList<>();
        for (int time : new int[]{Integer.MIN_VALUE, -1, 0, 1, Integer.MAX_VALUE})
            for (int round : new int[]{Integer.MIN_VALUE, 0, Integer.MAX_VALUE})
                for (LegMode mode : new LegMode[]{null, LegMode.WALK, LegMode.CAR})
                    edges.add(state(time, round, mode));
        enumerate(edges, new McRaptorState[3], 0);
        Random random = new Random(20260912);
        LegMode[] modes = LegMode.values();
        for (int run = 0; run < 10000; run++) {
            List<McRaptorState> sequence = new ArrayList<>();
            for (int i = 0; i < 100; i++) {
                sequence.add(state(random.nextInt(7), random.nextInt(6),
                        random.nextBoolean() ? null : modes[random.nextInt(modes.length)]));
            }
            compare(sequence);
        }
        List<McRaptorState> ties = new ArrayList<>();
        for (int i = 0; i < 2048; i++) ties.add(state(100, 3, LegMode.WALK));
        ties.add(state(100, 2, LegMode.WALK));
        ties.add(state(100, 1, LegMode.CAR));
        ties.add(state(99, 5, null));
        compare(ties);
        if (!(McRaptorSuboptimalPathProfileRouter.createSuboptimalListSupplier(5).apply(0)
                instanceof SuboptimalDominatingList)) throw new AssertionError("Nonzero policy changed");
        System.out.printf("{\"sequences\":%d,\"insertions\":%d,\"mismatches\":0}%n", sequences, insertions);
    }
}
