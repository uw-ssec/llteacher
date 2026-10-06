# Onboarding

**Load when:** setting up this repository for the first time, or helping a new
contributor get started.

For a guided first session — machine setup, what LLTeacher does, the
architecture, and the must-knows — use the `onboard` skill; this file covers the
SSEC onboarding tooling it calls.

## Onboarding Workflow (First-Time Setup)

```bash
# Install the onboard environment
pixi install -e onboard

# Run the complete onboarding process
pixi run -e onboard onboard
# This executes in order:
# 1. pixi run pre-commit-install  (installs git hooks)
# 2. pixi run ssec-setup          (sets up shell completion for ssec CLI)
# 3. ssec onboard                 (runs SSEC onboarding interactive process)

# Or run individual onboarding steps:
pixi run -e onboard ssec-setup
# ✓ Installs zsh/bash completion for ssec CLI
# ⚠️ Completion takes effect after restarting terminal
```

## Project setup after onboarding

```bash
pixi install          # tooling: pre-commit, gh, okf
npm install           # TypeScript workspaces (Node >=24, see .nvmrc)
pixi run pre-commit-install
pixi run verify       # confirms the toolchain works end to end
```

Then read `knowledge/index.md` (or `pixi run okf search "<topic>"`) for the
project's recorded decisions, and the `dev-server` skill to run the apps.

## The `ssec` CLI

The `ssec` CLI contains convenience functions for setting up and working with
this repository: https://github.com/uw-ssec/ssec-cli

```bash
# Run an ssec command
pixi run ssec <options>

# For tab completion, open a Pixi shell first
pixi shell
ssec <tab>
```
