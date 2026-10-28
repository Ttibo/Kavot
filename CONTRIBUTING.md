# Contributing to Kavot

Bug reports, suggestions and fixes are welcome. Before a significant change,
open a discussion or an issue to agree on its scope. For a fix, describe the
problem, the solution and how to verify it.

1. Install the dependencies by following the [README](README.md#quick-start).
2. Make a focused change and keep data already stored in workspaces compatible.
3. Run the relevant checks listed in the README, and the backend tests:
   `python -m pip install -e ".[dev]"` then `python -m pytest`.
   A new domain goes into a plugin: see [app/plugins/README.md](app/plugins/README.md).
4. Open a pull request with a clear description of the changes and any
   limitations.

The [repository license](LICENSE) reserves commercial use to the copyright
holder. Before an external code contribution is merged, the rights needed to use
and redistribute it must therefore be clarified with its author. Do not add
secrets, personal data, or files produced by builds.
