# Project Engineering Rules

## Goal

Deliver correct, maintainable, production-grade changes without separating work by agent or model role.

## Change Discipline

Unless explicitly required:

- Do not refactor unrelated code.
- Do not introduce unnecessary abstractions.
- Do not rename unrelated symbols.
- Do not change behavior outside the requested scope.
- Do not modify unrelated files.
- Preserve existing architecture and coding style.
- Prefer existing utilities and patterns.
- Production source directories must not contain test implementations. In Rust, do not add `#[cfg(test)] mod tests`, `#[test]` functions, test fixtures, or test-only helpers under `src-tauri/src/`; place all Rust test implementations under `src-tauri/tests/` and wire them through the test entrypoint.
- Persistent credentials must use Rivet-owned cross-platform storage by default. Do not introduce or use macOS Keychain, Windows Credential Manager, Linux Secret Service/keyring, or similar platform-native credential stores unless the user explicitly requests that native integration.
- Prefer platform-independent, application-owned implementations and cross-platform Rust/library abstractions over OS-native services, frameworks, APIs, or system integrations whenever the required behavior can be implemented reliably without them. Use platform-native functionality only when it is unavoidable for the capability itself or the user explicitly requires it; keep unavoidable platform-specific code isolated behind a small interface and preserve consistent behavior across Windows, macOS, and Linux.

## Verification

Run relevant verification commands when available.

Verification order:

1. Format
2. Compile/type-check
3. Relevant tests
4. Lint/static analysis

Do not report success when required verification fails.

## Review Policy

Review the changed files, diff, and compiler/test/lint results. Do not reread the entire repository unless necessary.

Use deeper review for:

- Core protocol logic
- Cryptography/security code
- Concurrency
- Memory safety
- Persistent data changes
- Public API changes
- Large cross-module refactors

## Mandatory Rule Closure

The following steps are required for every code, documentation, configuration,
test, deployment, or automation task. They are execution gates, not optional
guidance:

1. Before changing files, identify the applicable user instructions,
   `AGENTS.md` rules, selected skills, language rules, and repository
   conventions. Extract each requirement into a short internal checklist and
   mark its scope and validation method.
2. Before implementation, inventory every touched file, type, field, constant,
   function and parameter, pointer, buffer, handle, external input, system
   call, error path, resource cleanup path, test, and documentation section.
3. After implementation, audit the complete inventory and every added or
   modified line. Do not limit review to the last reported omission or to the
   compiler diff. Each item must be marked `满足`, `不适用`, `未满足`, or
   `未验证`; `未满足` and `未验证` block completion.
4. For C/C++ changes, explicitly check the selected language skill's rules for
   comments, function contracts, ownership, lifetime, bounds, overflow,
   system-call results, cleanup, control-flow braces, magic numbers, ABI,
   concurrency, and required validation. Compilation or tests cannot replace
   this audit.
5. If an audit finds any gap, fix it and repeat the full audit. Do not report
   success based on a partial repair or an unchanged previous check.
6. Before the final response, verify that the reported result matches evidence
   from the actual diff and commands. State required limitations and
   unverified hardware, deployment, or platform validation instead of
   implying success.
