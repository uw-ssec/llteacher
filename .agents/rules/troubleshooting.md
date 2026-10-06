# Troubleshooting

**Load when:** a documented command fails or behaves unexpectedly.

## Issue: "pre-commit not found" or command fails

**Solution:** Run `pixi install` first. Pixi manages pre-commit installation.

## Issue: Pre-commit check fails after making fixes

**Behavior:** Pre-commit hooks like `trailing-whitespace` auto-fix files. When
this happens:

- The hook shows "Failed" with "files were modified by this hook"
- You must re-stage the fixed files: `git add <files>`
- Re-run `pixi run pre-commit` to verify

**This is expected behavior, not an error.**

## Issue: Modifying pixi.toml breaks the environment

**Solution:**

```bash
# Validate syntax, reinstall environment
pixi install

# If still broken, remove and reinstall
rm -rf .pixi
pixi install
```

## Issue: Platform-specific problems (non-macOS)

**Solution:** Edit `pixi.toml` and add platforms:

```toml
platforms = ["osx-arm64", "linux-64", "win-64"]
```

Then run `pixi install`.

## Issue: `gh` shows the wrong issues or PRs

**Cause:** the clone has the upstream fork `RedBeardLab/llteacher` as a remote,
and a bare `gh issue list` resolves there.

**Solution:** always pass `-R uw-ssec/llteacher`.

## Issue: `pixi run gh ... '{{...}}'` or `pixi run okf ... --body '...{{...'` fails

**Cause:** pixi treats `{{` as a task-argument placeholder.

**Solution:** use `--json`/`--jq`, or call `.pixi/envs/default/bin/gh` (or
`.../okf`) directly.

## Issue: `pixi run verify` fails at `app-typecheck` but CI is green

**Cause:** usually stale `node_modules` after a pull that changed
`package-lock.json`, or a Node older than 24.

**Solution:** `npm install`, check `node --version`, rerun.

## Issue: Harbor tasks fail to start

**Cause:** the Docker daemon is not running (it is not started at login on
macOS).

**Solution:** `open -a Docker`, wait for `docker info` to succeed, then
`pixi run -e evals harbor-oracle`.
