"""Structural checks that keep the skill evals in step with the skills.

Every skill under ``.agents/skills`` must have Inspect samples and a Harbor
task, every Harbor task must be complete, and the fake CLIs the Harbor tasks
rely on must pass their own self-test.
"""

from __future__ import annotations

import subprocess
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SKILLS_DIR = ROOT / ".agents" / "skills"
SAMPLES_DIR = ROOT / "skill-evals" / "inspect" / "samples"
HARBOR_TASKS_DIR = ROOT / "skill-evals" / "harbor" / "tasks"
SHIMS_TEST = ROOT / "skill-evals" / "harbor" / "base" / "shims" / "test_shims.sh"
HARBOR_TASK_FILES = (
    "task.toml",
    "instruction.md",
    "environment/Dockerfile",
    "solution/solve.sh",
    "tests/test.sh",
)

SKILL_NAMES: list[str] = sorted(
    p.name for p in SKILLS_DIR.iterdir() if (p / "SKILL.md").is_file()
)


def test_skills_were_found() -> None:
    # 9 template skills + 6 project skills
    assert len(SKILL_NAMES) >= 15


def test_every_skill_has_inspect_samples() -> None:
    missing = [n for n in SKILL_NAMES if not (SAMPLES_DIR / f"{n}.yaml").is_file()]
    assert missing == []


def test_every_samples_file_names_a_skill() -> None:
    orphans = [p.stem for p in SAMPLES_DIR.glob("*.yaml") if p.stem not in SKILL_NAMES]
    assert orphans == []


def test_every_skill_has_harbor_task() -> None:
    missing = [n for n in SKILL_NAMES if not (HARBOR_TASKS_DIR / n).is_dir()]
    assert missing == []


def test_every_harbor_task_is_complete() -> None:
    incomplete = [
        f"{task.name}/{rel}"
        for task in sorted(HARBOR_TASKS_DIR.iterdir())
        if task.is_dir()
        for rel in HARBOR_TASK_FILES
        if not (task / rel).is_file()
    ]
    assert incomplete == []


def test_every_harbor_task_delivers_skills() -> None:
    wrong = [
        task.name
        for task in sorted(HARBOR_TASKS_DIR.iterdir())
        if task.is_dir()
        and tomllib.loads((task / "task.toml").read_text())["environment"].get(
            "skills_dir"
        )
        != "/skills"
    ]
    assert wrong == []


def test_shims_self_test() -> None:
    result = subprocess.run(
        ["bash", str(SHIMS_TEST)], capture_output=True, text=True, check=False
    )
    assert result.returncode == 0, result.stdout + result.stderr
