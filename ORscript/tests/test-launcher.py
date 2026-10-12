"""Smoke tests for the Roblox Studio MCP launcher selection logic."""

import os
import tempfile
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from unittest import mock

import launch_studio_mcp as launcher


class LauncherTests(unittest.TestCase):
    def test_prefers_roblox_documented_windows_launcher_when_present(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            mcp_bat = root / "Roblox" / "mcp.bat"
            mcp_bat.parent.mkdir()
            mcp_bat.write_text("@echo off\r\n", encoding="utf-8")
            with mock.patch.dict(os.environ, {"LOCALAPPDATA": str(root)}, clear=False):
                self.assertEqual(launcher._official_windows_launcher(), mcp_bat)

    def test_windows_binary_fallback_prefers_a_complete_newer_studio_install(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            old = root / "old"
            new = root / "new"
            old.mkdir()
            new.mkdir()
            (old / "StudioMCP.exe").touch()
            (new / "StudioMCP.exe").touch()
            (new / "RobloxStudioBeta.exe").touch()
            os.utime(new / "StudioMCP.exe", (2, 2))
            with mock.patch.object(launcher, "_candidate_roots_windows", return_value=[root]):
                self.assertEqual(launcher._find_studio_mcp_windows(), new / "StudioMCP.exe")

if __name__ == '__main__':
    unittest.main(verbosity=2)
