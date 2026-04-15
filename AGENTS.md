# AGENTS.md

## Global rules

1. Never edit files outside your assigned scope.
2. Never assume another module is implemented internally.
3. Depend only on `contracts/*.json` and third-party packages.
4. Preserve CLI contracts exactly.
5. Write runnable code and runnable tests.
6. Keep implementations deterministic unless the assignment explicitly requires a probabilistic model.

## File ownership

- `modules/parser/**` belongs to the parser worker
- `modules/layout-analyzer/**` belongs to the layout worker
- `modules/semantic-engine/**` belongs to the semantic worker
- `modules/reading-order/**` belongs to the reading-order worker
- `modules/tag-builder/**` belongs to the tag-builder worker
- `modules/font-embedder/**` belongs to the font-embedder worker
- `modules/pdf-writer/**` belongs to the PDF writer worker
- `modules/validator/**` belongs to the validator worker
- `orchestrator/**` belongs to the orchestrator worker
- `contracts/**`, `SPEC.txt`, and `AGENTS.md` are shared and should only be changed by the contract owner

## Development flow

1. Read `SPEC.txt`
2. Read `contracts/*.json`
3. Implement your module in isolation
4. Expose a CLI entrypoint
5. Add module-local tests
6. Do not reach into another module for helper code

## CLI conventions

- A module must accept file paths as arguments.
- A module must write JSON to stdout unless it is explicitly writing a binary artifact to a target path.
- Errors must go to stderr and exit non-zero.

## Contract discipline

- Validate your output against the relevant schema.
- Prefer additive fields over breaking changes.
- If a contract gap blocks implementation, stop and propose a contract update instead of inventing a private format.

