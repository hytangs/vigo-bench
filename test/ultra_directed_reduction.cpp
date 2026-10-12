#include <algorithm>
#include <cstdlib>
#include <iostream>
#include <limits>
#include <vector>
#include "DataStructures/Intermediate/Data.h"

using Matrix = std::vector<std::vector<long long>>;

Matrix allPairs(const Intermediate::TransferGraph& graph) {
    const long long inf = 1LL << 50;
    Matrix d(graph.numVertices(), std::vector<long long>(graph.numVertices(), inf));
    for (size_t v = 0; v < d.size(); ++v) d[v][v] = 0;
    for (const Edge e : graph.edges()) {
        auto& value = d[graph.get(FromVertex,e)][graph.get(ToVertex,e)];
        value = std::min(value, static_cast<long long>(graph.get(TravelTime,e)));
    }
    for (size_t k = 0; k < d.size(); ++k)
        for (size_t a = 0; a < d.size(); ++a)
            for (size_t b = 0; b < d.size(); ++b)
                d[a][b] = std::min(d[a][b], d[a][k]+d[k][b]);
    return d;
}

void check(unsigned mask, int stopCount, int weightMode) {
    Intermediate::Data data;
    data.transferGraph.addVertices(4);
    Intermediate::Trip trip("fixture", "fixture", 3);
    for (int v = 0; v < stopCount; ++v) {
        data.stops.emplace_back(std::to_string(v));
        trip.stopEvents.emplace_back(StopId(v), v*100, v*100);
    }
    data.trips.push_back(trip);
    unsigned bit = 0;
    for (int from = 0; from < 4; ++from) {
        for (int to = 0; to < 4; ++to) {
            if (from == to) continue;
            if (mask & (1U << bit)) {
                int weight = weightMode == 0 ? 1 : weightMode == 1 ? (from*7+to*5)%11
                    : std::numeric_limits<int>::max()/2+1;
                data.transferGraph.addEdge(Vertex(from),Vertex(to)).set(TravelTime,weight);
            }
            ++bit;
        }
    }
    const auto before = allPairs(data.transferGraph);
    data.contractDegreeTwoVertices();
    const auto after = allPairs(data.transferGraph);
    if (data.numberOfStops() != static_cast<size_t>(stopCount)) std::abort();
    for (int from = 0; from < stopCount; ++from) {
        for (int to = 0; to < stopCount; ++to) {
            if (before[from][to] != after[from][to]) {
                std::cerr << "Shortest distance changed: mask=" << mask << " stops=" << stopCount
                          << " weights=" << weightMode << " pair=" << from << "," << to << std::endl;
                std::abort();
            }
        }
    }
}

int main() {
    // Enumerate every directed simple graph on four vertices, with one or two
    // removable vertices and three weight patterns. This includes asymmetric
    // shortcuts, missing reverse arcs, sources/sinks, zero costs and overflow.
    for (int stops : {2,3})
        for (int weights : {0,1,2})
            for (unsigned mask = 0; mask < (1U << 12); ++mask)
                check(mask,stops,weights);
    std::cerr << "Passed 24576 exhaustive directed-graph fixtures; all stop-pair distances preserved.\n";
}
