"""Tests for macOS runtime wheel deployment-target validation."""

from __future__ import annotations

import runpy
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest


ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "scripts" / "check-macos-deployment-target.py"
checker = SimpleNamespace(**runpy.run_path(str(SCRIPT)))


def test_otool_parser_uses_the_newest_macho_slice() -> None:
    output = """
      cmd LC_BUILD_VERSION
    minos 11.0
      cmd LC_BUILD_VERSION
    minos 13.5
    """

    assert checker.parse_otool_deployment_target(output) == (13, 5)


def test_otool_parser_requires_a_deployment_target() -> None:
    with pytest.raises(ValueError, match="contains no LC_BUILD_VERSION"):
        checker.parse_otool_deployment_target("Load command 0\n")


def test_wheel_tag_rejects_a_newer_executable_target() -> None:
    checker.ensure_compatible(Path("runtime"), (13, 5), "macosx_14_0_arm64")
    checker.ensure_compatible(Path("runtime"), (13, 5), "macosx_14_0_x86_64")

    with pytest.raises(RuntimeError, match="requires macOS 14.1"):
        checker.ensure_compatible(Path("spawn-helper"), (14, 1), "macosx_14_0_arm64")


def test_cli_accepts_a_platform_tag_and_reports_it(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setitem(
        checker.main.__globals__,
        "validate_deployment_targets",
        lambda executables, platform_tag: [(executables[0], (13, 5))],
    )
    monkeypatch.setattr(sys, "argv", [str(SCRIPT), "--platform-tag", "macosx_14_0_x86_64", "runtime"])

    checker.main()

    assert capsys.readouterr().out == "runtime: macOS 13.5 <= macosx_14_0_x86_64\n"


def test_cli_defaults_to_the_arm64_platform_tag(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setitem(
        checker.main.__globals__,
        "validate_deployment_targets",
        lambda executables, platform_tag: [(executables[0], (13, 5))],
    )
    monkeypatch.setattr(sys, "argv", [str(SCRIPT), "runtime"])

    checker.main()

    assert capsys.readouterr().out == f"runtime: macOS 13.5 <= {checker.MACOS_PLATFORM_TAG}\n"
