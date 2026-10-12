#include <algorithm>
#include <chrono>
#include <cstddef>
#include <iostream>
#include <iomanip>
#include <cmath>
#include <sstream>
#include <string>
#include <vector>
#include <queue>
#include <limits>

#include "DataStructures/RAPTOR/Data.h"
#include "DataStructures/RAPTOR/Entities/ArrivalLabel.h"
#include "DataStructures/RAPTOR/Entities/Journey.h"
#include "Algorithms/CH/CHUtils.h"
#include "Algorithms/CH/CH.h"
#include "Algorithms/RAPTOR/ULTRARAPTOR.h"
#include "DataStructures/Geometry/Metric.h"
#include "DataStructures/Geometry/CoordinateTree.h"
#include "DataStructures/Graph/Graph.h"

namespace {

class BoundedBucketCHInitialTransfers {
public:
    using Graph = CHGraph;

    template<typename ATTRIBUTE>
    BoundedBucketCHInitialTransfers(
        const Graph& forward,
        const Graph& backward,
        const Vertex::ValueType endOfPOIs,
        const ATTRIBUTE attribute
    ) :
        query(forward, backward, endOfPOIs, attribute) {
    }

    static void setMaximumTransferTime(const int access, const int egress) noexcept {
        maximumAccessTime = std::max(0, access);
        maximumEgressTime = std::max(0, egress);
    }

    template<bool TARGET_PRUNING = true>
    inline void run(
        const Vertex from,
        const Vertex to,
        const double targetPruningFactor = 1
    ) noexcept {
        query.template run<TARGET_PRUNING>(from, to, targetPruningFactor);
        forwardPOIs.clear();
        backwardPOIs.clear();
        for (const Vertex vertex : query.getForwardPOIs()) {
            if (query.getForwardDistance(vertex) <= maximumAccessTime) {
                forwardPOIs.emplace_back(vertex);
            }
        }
        for (const Vertex vertex : query.getBackwardPOIs()) {
            if (query.getBackwardDistance(vertex) <= maximumEgressTime) {
                backwardPOIs.emplace_back(vertex);
            }
        }
    }

    inline int getDistance(const Vertex = noVertex) const noexcept {
        return INFTY;
    }

    inline int getForwardDistance(const Vertex vertex) const noexcept {
        const int distance = query.getForwardDistance(vertex);
        return distance <= maximumAccessTime ? distance : INFTY;
    }

    inline int getBackwardDistance(const Vertex vertex) const noexcept {
        const int distance = query.getBackwardDistance(vertex);
        return distance <= maximumEgressTime ? distance : INFTY;
    }

    inline const std::vector<Vertex>& getForwardPOIs() const noexcept {
        return forwardPOIs;
    }

    inline const std::vector<Vertex>& getBackwardPOIs() const noexcept {
        return backwardPOIs;
    }

private:
    CH::BucketQuery<CHGraph, true, false> query;
    std::vector<Vertex> forwardPOIs;
    std::vector<Vertex> backwardPOIs;
    inline static int maximumAccessTime = INFTY;
    inline static int maximumEgressTime = INFTY;
};

std::vector<std::string> splitTabs(const std::string& line) {
    std::vector<std::string> fields;
    std::size_t begin = 0;
    while (true) {
        const std::size_t end = line.find('\t', begin);
        fields.emplace_back(line.substr(begin, end - begin));
        if (end == std::string::npos) return fields;
        begin = end + 1;
    }
}

std::string routeIds(const RAPTOR::Journey& journey) {
    std::ostringstream result;
    bool first = true;
    for (const RAPTOR::JourneyLeg& leg : journey) {
        if (!leg.usesRoute || leg.routeId == noRouteId) continue;
        if (!first) result << ',';
        first = false;
        result << leg.routeId.value();
    }
    return result.str();
}

bool isLegalJourney(
    const RAPTOR::Journey& journey,
    const int requestedDeparture,
    const std::size_t maximumBoardings,
    const int maximumEndpointWalkSeconds
) {
    if (journey.empty()) return false;
    if (journey.front().departureTime < requestedDeparture) return false;
    for (std::size_t i = 0; i < journey.size(); i++) {
        const RAPTOR::JourneyLeg& leg = journey[i];
        if (leg.arrivalTime < leg.departureTime) return false;
        if (i == 0) continue;
        const RAPTOR::JourneyLeg& previous = journey[i - 1];
        if (previous.to != leg.from) return false;
        if (previous.arrivalTime > leg.departureTime) return false;
    }
    const std::size_t boardings = RAPTOR::countTrips(journey);
    if (boardings > maximumBoardings) return false;
    if (boardings == 0) {
        return RAPTOR::totalTransferTime(journey) <= maximumEndpointWalkSeconds;
    }
    const int accessWalkSeconds = journey.front().usesRoute
        ? 0
        : journey.front().arrivalTime - journey.front().departureTime;
    const int egressWalkSeconds = journey.back().usesRoute
        ? 0
        : journey.back().arrivalTime - journey.back().departureTime;
    return accessWalkSeconds <= maximumEndpointWalkSeconds
        && egressWalkSeconds <= maximumEndpointWalkSeconds;
}

struct WalkBreakdown {
    int accessWalkSeconds;
    int egressWalkSeconds;
    int directWalkSeconds;
    bool directWalk;
};

WalkBreakdown walkBreakdown(const RAPTOR::Journey& journey) {
    const std::size_t boardings = RAPTOR::countTrips(journey);
    if (boardings == 0) {
        return {
            .accessWalkSeconds = 0,
            .egressWalkSeconds = 0,
            .directWalkSeconds = RAPTOR::totalTransferTime(journey),
            .directWalk = true,
        };
    }
    return {
        .accessWalkSeconds = journey.front().usesRoute
            ? 0
            : journey.front().arrivalTime - journey.front().departureTime,
        .egressWalkSeconds = journey.back().usesRoute
            ? 0
            : journey.back().arrivalTime - journey.back().departureTime,
        .directWalkSeconds = 0,
        .directWalk = false,
    };
}

} // namespace

int main(int argc, char** argv) {
    if (argc != 4) {
        std::cerr << "usage: ultra-osm-kernel <RAPTOR-shortcuts> <CH-data> <coordinate-graph>\n";
        return 2;
    }

    std::streambuf* protocolBuffer = std::cout.rdbuf();
    std::cout.rdbuf(std::cerr.rdbuf());
    RAPTOR::Data data(argv[1]);
    CH::CH ch(argv[2]);
    TransferGraph coordinateGraph(argv[3]);
    std::cout.rdbuf(protocolBuffer);
    data.useImplicitDepartureBufferTimes();
    if (ch.numVertices() != coordinateGraph.numVertices()) {
        std::cerr
            << "CH/coordinate graph vertex-count mismatch: "
            << ch.numVertices() << " versus " << coordinateGraph.numVertices() << '\n';
        return 3;
    }
    if (data.numberOfStops() > coordinateGraph.numVertices()) {
        std::cerr << "RAPTOR stop count exceeds coordinate graph vertex count\n";
        return 3;
    }
    using Algorithm = RAPTOR::ULTRARAPTOR<
        RAPTOR::NoProfiler,
        true,
        BoundedBucketCHInitialTransfers
    >;
    Algorithm algorithm(data, ch);
    // A partial Core-CH query does not itself provide a general street path
    // witness. Reconstruct each selected walk on the full reduced OSM graph.
    auto streetPath = [&](Vertex from, Vertex to, int maximumTime) {
        std::vector<int> distance(coordinateGraph.numVertices(), INFTY);
        std::vector<Vertex> parent(coordinateGraph.numVertices(), noVertex);
        using Entry = std::pair<int, Vertex>;
        std::priority_queue<Entry, std::vector<Entry>, std::greater<Entry>> queue;
        distance[from] = 0;
        queue.emplace(0, from);
        while (!queue.empty()) {
            const auto [cost, vertex] = queue.top();
            queue.pop();
            if (cost != distance[vertex]) continue;
            if (vertex == to) break;
            for (const Edge edge : coordinateGraph.edgesFrom(vertex)) {
                const auto target = coordinateGraph.get(ToVertex, edge);
                const int next = cost + coordinateGraph.get(TravelTime, edge);
                if (next > maximumTime + 1 || next >= distance[target]) continue;
                distance[target] = next;
                parent[target] = vertex;
                queue.emplace(next, target);
            }
        }
        std::vector<Geometry::Point> points;
        if (distance[to] == INFTY) return points;
        for (auto vertex = to; vertex != noVertex; vertex = parent[vertex]) {
            points.push_back(coordinateGraph.get(Coordinates, vertex));
            if (vertex == from) break;
        }
        std::reverse(points.begin(), points.end());
        return points;
    };

    const Geometry::Rectangle bounds = Geometry::Rectangle::BoundingBox(coordinateGraph[Coordinates]);
    const Geometry::GeoMetricAproximation metric = Geometry::GeoMetricAproximation::ComputeCorrection(bounds.center());
    CoordinateTree<Geometry::GeoMetricAproximation> coordinateTree(metric, coordinateGraph[Coordinates]);
    std::vector<Geometry::Point> stopCoordinates;
    stopCoordinates.reserve(data.numberOfStops());
    for (const StopId stop : data.stops()) {
        stopCoordinates.emplace_back(coordinateGraph.get(Coordinates, stop));
    }
    CoordinateTree<Geometry::GeoMetricAproximation> stopCoordinateTree(metric, stopCoordinates);
    std::cerr << "ULTRA OSM kernel ready: " << data.numberOfStops() << " stops, "
              << data.numberOfRoutes() << " routes, "
              << coordinateGraph.numVertices() << " OSM/stop vertices, "
              << ch.numEdges() << " CH arcs\n";

    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;
        const std::vector<std::string> fields = splitTabs(line);
        if (fields.size() != 10) {
            std::cerr << "invalid query field count: " << fields.size() << '\n';
            continue;
        }
        const std::string& requestId = fields[0];
        const double sourceLon = std::stod(fields[1]);
        const double sourceLat = std::stod(fields[2]);
        const double targetLon = std::stod(fields[3]);
        const double targetLat = std::stod(fields[4]);
        const int departureTime = std::stoi(fields[5]);
        const std::size_t maximumBoardings = std::stoul(fields[6]);
        const double maximumSnapMeters = std::stod(fields[7]);
        const int maximumEndpointWalkSeconds = std::stoi(fields[8]);
        const double maximumWalkMeters = std::stod(fields[9]);
        if (maximumEndpointWalkSeconds < 0 || maximumWalkMeters < 0) {
            std::cout << requestId << "\terror\tinvalid-walking-budget\n";
            std::cout.flush();
            continue;
        }
        const Geometry::Point sourcePoint(Construct::LatLong, sourceLat, sourceLon);
        const Geometry::Point targetPoint(Construct::LatLong, targetLat, targetLon);
        const Vertex source = coordinateTree.getNearestNeighbor(sourcePoint);
        const Vertex target = coordinateTree.getNearestNeighbor(targetPoint);
        const double sourceSnapMeters = Geometry::geoDistanceInCM(
            sourcePoint,
            coordinateGraph.get(Coordinates, source)
        ) / 100.0;
        const double targetSnapMeters = Geometry::geoDistanceInCM(
            targetPoint,
            coordinateGraph.get(Coordinates, target)
        ) / 100.0;
        const Vertex sourceNearestStop = stopCoordinateTree.getNearestNeighbor(sourcePoint);
        const Vertex targetNearestStop = stopCoordinateTree.getNearestNeighbor(targetPoint);
        const double sourceNearestStopMeters = Geometry::geoDistanceInCM(
            sourcePoint,
            stopCoordinates[sourceNearestStop]
        ) / 100.0;
        const double targetNearestStopMeters = Geometry::geoDistanceInCM(
            targetPoint,
            stopCoordinates[targetNearestStop]
        ) / 100.0;
        const bool sourceIsStop = data.isStop(source);
        const bool targetIsStop = data.isStop(target);
        if (maximumSnapMeters >= 0 && (sourceSnapMeters > maximumSnapMeters || targetSnapMeters > maximumSnapMeters)) {
            std::cout << requestId << "\tblocked\t0\tendpoint-snap"
                      << '\t' << sourceSnapMeters
                      << '\t' << targetSnapMeters
                      << '\t' << source.value()
                      << '\t' << target.value()
                      << '\t' << sourceIsStop
                      << '\t' << targetIsStop
                      << '\t' << sourceNearestStopMeters
                      << '\t' << targetNearestStopMeters
                      << '\t' << maximumWalkMeters
                      << '\t' << maximumEndpointWalkSeconds
                      << "\t-1\t-1\t0\t-1"
                      << '\n';
            std::cout.flush();
            continue;
        }

        const int sourceSnapSeconds = std::ceil(sourceSnapMeters / (4.8 / 3.6));
        const int targetSnapSeconds = std::ceil(targetSnapMeters / (4.8 / 3.6));
        BoundedBucketCHInitialTransfers::setMaximumTransferTime(
            maximumEndpointWalkSeconds - sourceSnapSeconds,
            maximumEndpointWalkSeconds - targetSnapSeconds);
        const auto started = std::chrono::steady_clock::now();
        algorithm.run(source, departureTime + sourceSnapSeconds, target, maximumBoardings);
        const std::vector<RAPTOR::Journey> journeys = algorithm.getJourneys();
        const std::uint64_t kernelNs = std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now() - started).count();
        if (journeys.empty()) {
            std::cout << requestId << "\tblocked\t" << kernelNs
                      << "\tno-journey"
                      << '\t' << sourceSnapMeters
                      << '\t' << targetSnapMeters
                      << '\t' << source.value()
                      << '\t' << target.value()
                      << '\t' << sourceIsStop
                      << '\t' << targetIsStop
                      << '\t' << sourceNearestStopMeters
                      << '\t' << targetNearestStopMeters
                      << '\t' << maximumWalkMeters
                      << '\t' << maximumEndpointWalkSeconds
                      << "\t-1\t-1\t0\t-1"
                      << '\n';
            std::cout.flush();
            continue;
        }
        const RAPTOR::Journey journey = journeys.back();
        if (!isLegalJourney(
            journey,
            departureTime,
            maximumBoardings,
            maximumEndpointWalkSeconds
        )) {
            std::cout << requestId << "\terror\tillegal-journey\n";
            std::cout.flush();
            continue;
        }
        const int arrivalTime = journey.back().arrivalTime + targetSnapSeconds;
        const std::size_t boardings = RAPTOR::countTrips(journey);
        const int walkSeconds = RAPTOR::totalTransferTime(journey);
        const WalkBreakdown walking = walkBreakdown(journey);
        std::ostringstream itinerary;
        itinerary << std::setprecision(10) << "{\"legs\":[";
        bool firstLeg = true;
        bool missingWalkingPath = false;
        auto emitLeg = [&](const std::string& mode, const int depart, const int arrive,
                           const std::vector<Geometry::Point>& points, const std::string& route,
                           const std::string& from, const std::string& to) {
            if (!firstLeg) itinerary << ',';
            firstLeg = false;
            itinerary << "{\"mode\":" << std::quoted(mode) << ",\"departureTime\":" << depart
                      << ",\"arrivalTime\":" << arrive << ",\"routeName\":" << std::quoted(route)
                      << ",\"fromName\":" << std::quoted(from) << ",\"toName\":" << std::quoted(to)
                      << ",\"coordinates\":[";
            for (size_t i = 0; i < points.size(); ++i) {
                if (i) itinerary << ',';
                itinerary << '[' << points[i].longitude << ',' << points[i].latitude << ']';
            }
            itinerary << "]}";
        };
        emitLeg("walk", departureTime, departureTime + sourceSnapSeconds,
                {sourcePoint, coordinateGraph.get(Coordinates, source)}, "", "origin", "street snap");
        for (const auto& leg : journey) {
            // ULTRARAPTOR represents an off-stop destination by a sentinel
            // stop index. Path extraction must use the actual street vertex.
            const Vertex legTo = (&leg == &journey.back()) ? target : Vertex(leg.to);
            std::vector<Geometry::Point> points;
            if (leg.usesRoute) {
                points = {coordinateGraph.get(Coordinates, leg.from), coordinateGraph.get(Coordinates, legTo)};
            } else {
                points = streetPath(leg.from, legTo, leg.arrivalTime - leg.departureTime);
                missingWalkingPath = missingWalkingPath || (points.empty() && leg.from != legTo);
            }
            emitLeg(leg.usesRoute ? "ride" : "walk", leg.departureTime, leg.arrivalTime, points,
                    leg.usesRoute ? data.routeData[leg.routeId].name : "",
                    data.isStop(leg.from) ? data.stopData[leg.from].name : "street snap",
                    data.isStop(legTo) ? data.stopData[legTo].name : "street snap");
        }
        emitLeg("walk", journey.back().arrivalTime, arrivalTime,
                {coordinateGraph.get(Coordinates, target), targetPoint}, "", "street snap", "destination");
        if (missingWalkingPath) {
            std::cout << requestId << "\terror\twalking-path-reconstruction-failed\n";
            std::cout.flush();
            continue;
        }
        itinerary << "],\"walkingGeometry\":\"shortest path on contracted OSM graph\",\"transitGeometry\":\"stop chords\"}";
        std::cout << requestId
                  << "\tready"
                  << '\t' << arrivalTime
                  << '\t' << (arrivalTime - departureTime)
                  << '\t' << walkSeconds
                  << '\t' << boardings
                  << '\t' << routeIds(journey)
                  << '\t' << kernelNs
                  << '\t' << sourceSnapMeters
                  << '\t' << targetSnapMeters
                  << '\t' << source.value()
                  << '\t' << target.value()
                  << '\t' << sourceIsStop
                  << '\t' << targetIsStop
                  << '\t' << sourceNearestStopMeters
                  << '\t' << targetNearestStopMeters
                  << '\t' << maximumWalkMeters
                  << '\t' << maximumEndpointWalkSeconds
                  << '\t' << walking.accessWalkSeconds
                  << '\t' << walking.egressWalkSeconds
                  << '\t' << walking.directWalk
                  << '\t' << walking.directWalkSeconds
                  << '\t' << itinerary.str()
                  << '\n';
        std::cout.flush();
    }
    return 0;
}
