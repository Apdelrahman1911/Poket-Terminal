#!/usr/bin/python3
"""Source-only limit regression: no imports of the supervisor, syscalls or GUI."""
import ast
from pathlib import Path
import unittest

class DesktopLimits(unittest.TestCase):
    def test_linux_thread_budget_without_sandbox_changes(self):
        source = Path(__file__).resolve().parents[1] / 'service' / 'supervisor.py'
        tree = ast.parse(source.read_text())
        limits = {}
        for node in ast.walk(tree):
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and isinstance(node.func.value, ast.Name) and node.func.value.id == 'resource'
                    and node.func.attr == 'setrlimit' and len(node.args) == 2
                    and isinstance(node.args[0], ast.Attribute)):
                limits[node.args[0].attr] = ast.literal_eval(node.args[1])
        self.assertEqual(limits['RLIMIT_NPROC'], (512, 512))  # Linux counts UID threads
        self.assertEqual(limits['RLIMIT_NOFILE'], (1024, 1024))
        self.assertEqual(limits['RLIMIT_CORE'], (0, 0))
        for flag in ('--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security', '--disable-site-isolation-trials'):
            self.assertNotIn(flag, source.read_text())

if __name__ == '__main__':
    unittest.main()
