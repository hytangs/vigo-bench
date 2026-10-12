#include <algorithm>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

#include "DataStructures/Graph/Graph.h"
#include "DataStructures/Intermediate/Data.h"

namespace {

void addDirectedTransferGraph(
    Intermediate::Data& data,
    const Intermediate::TransferGraph& graph,
    const double maximumUnificationDistanceInCM = 500,
    const double maximumConnectingDistanceInCM = 10000,
    const double speedInKMH = 4.5
) {
    std::cout << "Matching stops to nearest directed graph vertices.\n";
    const Geometry::Rectangle boundingBox =
        Geometry::Rectangle::BoundingBox(graph[Coordinates]);
    const Geometry::GeoMetricAproximation metric =
        Geometry::GeoMetricAproximation::ComputeCorrection(boundingBox.center());
    CoordinateTree<Geometry::GeoMetricAproximation> coordinateTree(
        metric,
        graph[Coordinates]
    );
    std::vector<std::vector<Vertex>> nearestOldVerticesOfNewVertex(
        graph.numVertices()
    );
    std::vector<double> distanceToNewVertex(
        data.transferGraph.numVertices(),
        maximumConnectingDistanceInCM
    );
    for (const Vertex oldVertex : data.transferGraph.vertices()) {
        const Vertex newVertex = coordinateTree.getNearestNeighbor(
            data.transferGraph.get(Coordinates, oldVertex)
        );
        const double distance = Geometry::geoDistanceInCM(
            data.transferGraph.get(Coordinates, oldVertex),
            graph.get(Coordinates, newVertex)
        );
        if (distance <= maximumConnectingDistanceInCM) {
            nearestOldVerticesOfNewVertex[newVertex].emplace_back(oldVertex);
            distanceToNewVertex[oldVertex] = distance;
        }
    }
    coordinateTree.clear();

    std::cout << "Adding directed road arcs and bidirectional stop connectors.\n";
    std::vector<Vertex> oldVertexOfNewVertex(graph.numVertices());
    for (const Vertex newVertex : graph.vertices()) {
        std::sort(
            nearestOldVerticesOfNewVertex[newVertex].begin(),
            nearestOldVerticesOfNewVertex[newVertex].end(),
            [&](const Vertex left, const Vertex right) {
                return distanceToNewVertex[left] < distanceToNewVertex[right];
            }
        );
        Vertex mergedVertex;
        if (
            nearestOldVerticesOfNewVertex[newVertex].empty()
            || distanceToNewVertex[
                nearestOldVerticesOfNewVertex[newVertex][0]
            ] > maximumUnificationDistanceInCM
        ) {
            mergedVertex = data.transferGraph.addVertex();
            data.transferGraph.set(
                Coordinates,
                mergedVertex,
                graph.get(Coordinates, newVertex)
            );
        } else {
            mergedVertex = nearestOldVerticesOfNewVertex[newVertex][0];
        }
        oldVertexOfNewVertex[newVertex] = mergedVertex;
        for (
            std::size_t index = 0;
            index < nearestOldVerticesOfNewVertex[newVertex].size();
            index++
        ) {
            const Vertex oldVertex =
                nearestOldVerticesOfNewVertex[newVertex][index];
            if (
                (index > 0
                    || distanceToNewVertex[oldVertex]
                        > maximumUnificationDistanceInCM)
                && distanceToNewVertex[oldVertex]
                    <= maximumConnectingDistanceInCM
            ) {
                const double travelTime =
                    (distanceToNewVertex[oldVertex] / speedInKMH) * 0.036;
                data.transferGraph
                    .addEdge(mergedVertex, oldVertex)
                    .set(TravelTime, travelTime);
                data.transferGraph
                    .addEdge(oldVertex, mergedVertex)
                    .set(TravelTime, travelTime);
            }
        }
    }
    for (const Vertex newVertex : graph.vertices()) {
        for (const Edge edge : graph.edgesFrom(newVertex)) {
            const Vertex from = oldVertexOfNewVertex[newVertex];
            const Vertex to = oldVertexOfNewVertex[graph.get(ToVertex, edge)];
            data.transferGraph
                .addEdge(from, to)
                .set(TravelTime, graph.get(TravelTime, edge));
        }
    }

    data.connectIsolatedStops(maximumConnectingDistanceInCM, speedInKMH);
    data.transferGraph.reduceMultiEdgesBy(TravelTime);
    data.transferGraph.packEdges();
    data.validate();
}

int runDirectedSelfTest() {
    Intermediate::Data data;
    Intermediate::TransferGraph graph;
    const Vertex first = graph.addVertex();
    const Vertex second = graph.addVertex();
    const Vertex third = graph.addVertex();
    graph.set(
        Coordinates,
        first,
        Geometry::Point(Construct::LatLong, 61.2100, -149.9000)
    );
    graph.set(
        Coordinates,
        second,
        Geometry::Point(Construct::LatLong, 61.2101, -149.9000)
    );
    graph.set(
        Coordinates,
        third,
        Geometry::Point(Construct::LatLong, 61.2102, -149.9000)
    );
    graph.addEdge(first, second).set(TravelTime, 7);
    graph.addEdge(second, third).set(TravelTime, 11);
    graph.addEdge(third, second).set(TravelTime, 13);
    graph.packEdges();

    addDirectedTransferGraph(data, graph);
    if (data.transferGraph.numVertices() != 3) {
        std::cerr << "directed self-test changed the vertex count\n";
        return 1;
    }
    if (
        !data.transferGraph.hasEdge(Vertex(0), Vertex(1))
        || data.transferGraph.hasEdge(Vertex(1), Vertex(0))
        || !data.transferGraph.hasEdge(Vertex(1), Vertex(2))
        || !data.transferGraph.hasEdge(Vertex(2), Vertex(1))
    ) {
        std::cerr << "directed self-test changed arc direction\n";
        return 1;
    }
    if (
        data.transferGraph.get(
            TravelTime,
            data.transferGraph.findEdge(Vertex(0), Vertex(1))
        ) != 7
        || data.transferGraph.get(
            TravelTime,
            data.transferGraph.findEdge(Vertex(1), Vertex(2))
        ) != 11
        || data.transferGraph.get(
            TravelTime,
            data.transferGraph.findEdge(Vertex(2), Vertex(1))
        ) != 13
    ) {
        std::cerr << "directed self-test changed arc weights\n";
        return 1;
    }
    std::cout << "ULTRA directed graph merger self-test passed.\n";
    return 0;
}

} // namespace

int main(int argc, char** argv) {
    if (argc == 2 && std::string(argv[1]) == "--self-test-directed") {
        return runDirectedSelfTest();
    }
    if (argc != 5) {
        std::cerr
            << "usage: ultra-osm-add-graph "
            << "<intermediate-data> <transfer-graph> <walk-speed-kmh> <output-data>\n";
        return 2;
    }

    const std::string intermediateFile = argv[1];
    const std::string transferGraphFile = argv[2];
    const double maximumWalkSpeedKmh = std::stod(argv[3]);
    const std::string outputFile = argv[4];
    if (!(maximumWalkSpeedKmh > 0)) {
        std::cerr << "walk speed must be positive\n";
        return 2;
    }

    // The upstream Network `addGraph` command first crops the road graph to the
    // exact transit-stop bounding box, and Intermediate::Data::addTransferGraph
    // inserts a reverse arc for every input road arc. Neither behavior is valid
    // for arbitrary coordinate endpoints on a directed OSM walking graph. This
    // wrapper retains the complete locked graph and preserves every road arc's
    // direction. Only the artificial stop-to-road connectors are bidirectional.
    Intermediate::Data data = Intermediate::Data::FromBinary(intermediateFile);
    Intermediate::TransferGraph graph(transferGraphFile);
    const std::size_t sourceGraphVertices = graph.numVertices();
    const std::size_t sourceGraphEdges = graph.numEdges();
    addDirectedTransferGraph(data, graph);
    data.applyMaxSpeed(maximumWalkSpeedKmh);
    data.validate();
    data.serialize(outputFile);

    std::cout
        << "ULTRA OSM graph merged: "
        << sourceGraphVertices << " source vertices, "
        << sourceGraphEdges << " source arcs, "
        << data.numberOfStops() << " stops, "
        << data.transferGraph.numVertices() << " merged vertices, "
        << data.transferGraph.numEdges() << " merged arcs\n";
    return 0;
}
