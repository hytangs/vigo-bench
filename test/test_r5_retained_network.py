"""Query replays must not rebuild or write retained R5 networks."""
import ast
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[1] / "scripts/r5-engine-adapter.py"


class RetainedNetworkTest(unittest.TestCase):
    def loader(self):
        tree = ast.parse(SOURCE.read_text())
        functions = [node for node in tree.body if isinstance(node, ast.FunctionDef)
                     and node.name in {"required_path", "load_network"}]
        self.loaded = []

        class Network:
            def _load_pickled_transport_network(instance, path):
                self.loaded.append(path)
                return "native-network"

        scope = {"os": os, "Path": Path,
                 "r5py": SimpleNamespace(TransportNetwork=Network)}
        exec(compile(ast.Module(functions, type_ignores=[]), str(SOURCE), "exec"), scope)
        return scope["load_network"]

    def test_query_opens_retained_network_without_import_inputs(self):
        loader = self.loader()
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "graph.transport_network"
            path.write_bytes(b"retained native graph")
            with patch.dict(os.environ, {"VIGO_BENCH_PHASE": "query",
                            "VIGO_BENCH_R5_NETWORK": str(path)}, clear=True):
                network, metadata = loader()
            self.assertEqual(network._transport_network, "native-network")
            self.assertEqual(self.loaded, [path.resolve()])
            self.assertTrue(metadata["readOnly"])
            self.assertEqual(path.read_bytes(), b"retained native graph")

    def test_prepare_never_substitutes_retained_graph_for_original_inputs(self):
        loader = self.loader()
        with patch.dict(os.environ, {"VIGO_BENCH_PHASE": "prepare",
                        "VIGO_BENCH_R5_NETWORK": "/some/retained.graph"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "missing VIGO_BENCH_OSM_PBF"):
                loader()
        self.assertEqual(self.loaded, [])

    def test_missing_retained_graph_is_an_error_without_rebuilding(self):
        loader = self.loader()
        with patch.dict(os.environ, {"VIGO_BENCH_PHASE": "query",
                        "VIGO_BENCH_R5_NETWORK": "/missing/retained.graph"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "Retained R5 network not found"):
                loader()
        self.assertEqual(self.loaded, [])


if __name__ == "__main__":
    unittest.main()
