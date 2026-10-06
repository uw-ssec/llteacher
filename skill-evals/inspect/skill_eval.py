"""Inspect evals that check a model follows a skill it has in context.

One task, ``skill``, covers every skill. Each skill has a YAML file under
``samples/`` listing user turns plus must / must-not rules on the reply. The
skill's ``SKILL.md`` body is injected as the system message, the model replies,
and a rule scorer marks the reply correct only if every rule holds.

Smoke run (deterministic, no API key)::

    pixi run -e evals inspect-smoke

One skill against a real model::

    pixi run -e evals inspect-skill -T name=db-migration --model anthropic/claude-haiku-4-5
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml
from inspect_ai import Task, task
from inspect_ai.dataset import Sample
from inspect_ai.model import ChatMessageSystem, ModelOutput
from inspect_ai.scorer import (
    CORRECT,
    INCORRECT,
    Score,
    Scorer,
    Target,
    accuracy,
    scorer,
)
from inspect_ai.solver import Generate, Solver, TaskState, generate, solver

ROOT = Path(__file__).resolve().parents[2]
SKILL_ROOTS = (ROOT / ".agents" / "skills",)
SAMPLES_DIR = Path(__file__).resolve().parent / "samples"
REGEX_PREFIX = "regex:"
TEXT_ONLY_NOTE = (
    "\n\n---\n\nThis is a text-only review: you cannot run commands or call tools. "
    "Reply with the exact commands you would run, in order, and anything you "
    "would say or ask the user."
)


def skill_body(name: str) -> str:
    """Return the SKILL.md body for ``name`` with its YAML frontmatter removed.

    Parameters
    ----------
    name
        Directory name of the skill under ``.agents/skills``.

    Returns
    -------
    str
        The markdown body, stripped.

    Raises
    ------
    FileNotFoundError
        If no root contains ``<name>/SKILL.md``.
    """
    for root in SKILL_ROOTS:
        path = root / name / "SKILL.md"
        if path.is_file():
            text = path.read_text()
            if text.startswith("---"):
                _, _, body = text.split("---", 2)
                return body.strip()
            return text.strip()
    msg = f"no SKILL.md for skill {name!r} under {[str(r) for r in SKILL_ROOTS]}"
    raise FileNotFoundError(msg)


def load_samples(name: str) -> list[Sample]:
    """Read ``samples/<name>.yaml`` into Inspect samples.

    Parameters
    ----------
    name
        Skill name; also the YAML file stem.

    Returns
    -------
    list[Sample]
        One sample per YAML entry. Metadata carries ``skill``, ``skill_body``,
        ``must``, ``must_not`` and ``smoke_answer``.

    Raises
    ------
    ValueError
        If an entry lacks ``input`` or ``smoke_answer``.
    """
    entries: list[dict[str, Any]] = yaml.safe_load(
        (SAMPLES_DIR / f"{name}.yaml").read_text()
    )
    if not isinstance(entries, list):
        msg = f"{name}.yaml must be a list of samples"
        raise ValueError(msg)  # noqa: TRY004  # malformed YAML data, not a bad argument
    body = skill_body(name)
    samples: list[Sample] = []
    for index, entry in enumerate(entries, start=1):
        if "input" not in entry or "smoke_answer" not in entry:
            msg = f"{name}.yaml entry {index} needs 'input' and 'smoke_answer'"
            raise ValueError(msg)
        samples.append(
            Sample(
                id=f"{name}-{index}",
                input=str(entry["input"]).strip(),
                target="",
                metadata={
                    "skill": name,
                    "skill_body": body,
                    "must": [str(r) for r in entry.get("must", [])],
                    "must_not": [str(r) for r in entry.get("must_not", [])],
                    "smoke_answer": str(entry["smoke_answer"]),
                },
            )
        )
    return samples


def rule_matches(text: str, rule: str) -> bool:
    """Return whether ``rule`` is found in ``text``.

    Parameters
    ----------
    text
        The model completion.
    rule
        A plain substring (case-insensitive) or ``regex:<pattern>`` (a
        case-sensitive, multiline regular expression, so flags like ``-d``
        and ``-D`` stay distinct).

    Returns
    -------
    bool
        True when the rule matches.

    Raises
    ------
    ValueError
        If the rule is a ``regex:`` rule with an invalid pattern.
    """
    if rule.startswith(REGEX_PREFIX):
        pattern = rule[len(REGEX_PREFIX) :]
        try:
            return re.search(pattern, text, re.MULTILINE) is not None
        except re.error as exc:
            msg = f"invalid regex rule {rule!r}: {exc}"
            raise ValueError(msg) from exc
    return rule.lower() in text.lower()


@solver
def inject_skill() -> Solver:
    """Prepend the sample's skill body as the system message.

    Returns
    -------
    Solver
        A solver that mutates ``state.messages``.
    """

    async def solve(state: TaskState, generate: Generate) -> TaskState:  # noqa: ARG001  # Inspect solver signature
        """Inspect callback."""
        state.messages.insert(
            0, ChatMessageSystem(content=state.metadata["skill_body"] + TEXT_ONLY_NOTE)
        )
        return state

    return solve


@solver
def smoke_answer() -> Solver:
    """Replace generation with the sample's canned answer.

    Returns
    -------
    Solver
        A solver that sets ``state.output`` without calling a model.
    """

    async def solve(state: TaskState, generate: Generate) -> TaskState:  # noqa: ARG001  # Inspect solver signature
        """Inspect callback."""
        state.output = ModelOutput.from_content(
            model="mockllm/model", content=state.metadata["smoke_answer"]
        )
        return state

    return solve


@scorer(metrics=[accuracy()])
def rules() -> Scorer:
    """Score a completion against the sample's must / must-not rules.

    Returns
    -------
    Scorer
        CORRECT only when every ``must`` matches and no ``must_not`` matches.
    """

    async def score(state: TaskState, target: Target) -> Score:  # noqa: ARG001  # Inspect scorer signature
        """Inspect callback."""
        text = state.output.completion
        for rule in state.metadata["must"]:
            if not rule_matches(text, rule):
                return Score(
                    value=INCORRECT, answer=text, explanation=f"missing: {rule}"
                )
        for rule in state.metadata["must_not"]:
            if rule_matches(text, rule):
                return Score(
                    value=INCORRECT, answer=text, explanation=f"forbidden: {rule}"
                )
        return Score(value=CORRECT, answer=text, explanation="all rules hold")

    return score


@task
def skill(name: str = "all", smoke: bool = False) -> Task:
    """Skill-following eval for one skill or for every skill with a samples file.

    Parameters
    ----------
    name
        A skill name, or ``"all"`` for every ``samples/*.yaml``.
    smoke
        When true, skip the model and replay each sample's ``smoke_answer``.
        Pass ``-T smoke=true --model mockllm/model``.

    Returns
    -------
    Task
        The configured Inspect task.
    """
    names = (
        sorted(p.stem for p in SAMPLES_DIR.glob("*.yaml")) if name == "all" else [name]
    )
    dataset = [sample for n in names for sample in load_samples(n)]
    answer: Solver = smoke_answer() if smoke else generate()
    return Task(dataset=dataset, solver=[inject_skill(), answer], scorer=rules())
