# Model Delegation Rules

## Goal

Minimize weekly primary-agent usage while preserving correctness and code quality.

The primary agent is the model selected for the current session; this role does not require switching models.

Use the primary agent for reasoning, planning, architecture, and difficult decisions. Delegate implementation-heavy work to GPT-6 Luna whenever possible.

## Primary Agent Responsibilities

Use the primary agent for:

- Requirement analysis
- Repository-level reasoning
- Architecture and interface design
- Complex debugging and root-cause analysis
- Protocol, algorithm, and data-format inference
- Cross-module design
- Security-sensitive decisions
- Task decomposition
- Final review of important diffs

Do not use the primary agent for routine implementation when GPT-6 Luna can complete it safely.

## GPT-6 Luna Responsibilities

Prefer GPT-6 Luna for:

- Writing implementation code
- Modifying existing functions
- Fixing compilation errors
- Fixing tests
- Adding tests
- Small refactors
- Formatting and lint fixes
- Mechanical migrations
- Clearly scoped feature implementation
- Repeated implementation/debug iterations

## Delegation Policy

Before implementing a non-trivial task:

1. Determine whether reasoning or implementation is the dominant work.
2. If substantial reasoning is required, the primary agent should:
   - inspect only the necessary code;
   - determine the solution;
   - define exact changes;
   - delegate implementation to GPT-6 Luna.

3. If the solution is already clear, delegate directly to GPT-6 Luna.
4. The primary agent should not duplicate implementation already delegated.

## Delegated Task Requirements

Every delegated task should specify:

- Goal
- Files or modules to modify
- Required behavior
- Constraints
- What must not be changed
- Acceptance criteria
- Build/test/lint commands to run

GPT-6 Luna should make the smallest correct change.

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

## Verification

GPT-6 Luna must run relevant verification commands when available.

Verification order:

1. Format
2. Compile/type-check
3. Relevant tests
4. Lint/static analysis

Do not report success when required verification fails.

## Review Policy

After GPT-6 Luna completes implementation, the primary agent should normally review only:

- Changed files
- Diff
- Compiler/test/lint results

Do not reread the entire repository unless necessary.

Use deeper primary-agent review for:

- Core protocol logic
- Cryptography/security code
- Concurrency
- Memory safety
- Persistent data changes
- Public API changes
- Large cross-module refactors

## Escalation

The primary agent should take over implementation only when:

- GPT-6 Luna cannot complete the task after reasonable attempts.
- Required behavior remains ambiguous.
- Architectural judgment is required.
- Critical security or correctness properties are involved.
- Debugging requires substantial new inference.

## Usage Efficiency

Optimize primarily for weekly primary-agent usage.

Preferred workflow:

Primary agent → analyze once → produce precise plan → GPT-6 Luna implements and iterates → primary agent reviews final diff.

Avoid using the primary agent for:

- Mechanical edits
- Routine implementation
- Individual compiler errors
- Formatting
- Repetitive test fixes
- Small isolated refactors

## Core Principle

**The primary agent decides what and why. GPT-6 Luna implements, tests, and fixes.**

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
   success based on a partial repair, an unchanged previous check, or a
   delegated agent's completion statement.
6. Before the final response, verify that the reported result matches evidence
   from the actual diff and commands. State required limitations and
   unverified hardware, deployment, or platform validation instead of
   implying success.
