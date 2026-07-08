# Plan: Create CLAUDE.md for pdf-reducer

## Context

The user ran `/init` to generate a `CLAUDE.md` for future Claude Code sessions. The repo is **greenfield**: it contains only `TASK.md` (the spec), `.gitignore`, and `.idea/`. There is no source code, build tooling, tests, or `package.json` yet.

Because there is no architecture to describe, the useful content of `CLAUDE.md` is: (1) the project's goal and hard constraints from `TASK.md`, and (2) the strict working process the user requires — since violating that process is the main way a future session would go wrong here.

## What the file must capture (all sourced from `TASK.md`)

**Project goal**
- Build `pdfSizeReducer.js` — a helper that reduces the size of user-uploaded (phone-scanned) PDFs.
- Single public method: `reduce(base64Pdf: string): string` — base64 PDF in, reduced base64 PDF out.

**Hard constraints**
- Language: JavaScript.
- Input and output are both base64-encoded strings.
- Prefer libraries over hand-rolled code where possible.
- **Licensing is a gating requirement — commercial application.** No AGPL / copyleft-encumbered dependencies. Ghostscript is explicitly excluded. Every candidate library's license must be checked before adoption.

**Working process (the user's General Rules — this is the critical part)**
- Never assume; research thoroughly and ask when anything is ambiguous.
- The task has ordered steps (research → compare libraries → present approaches with pros/cons → refine with user → write implementation plan → execute step by step). Do **not** advance to the next step without explicit user approval of the current one.
- Continuously document progress **and decisions**, including the *why*. When a decision changes, record what changed and why so the reasoning is auditable later.

## Plan of action

1. Create `/home/sha/projects/pdf-reducer/CLAUDE.md` with the required prefix header, then concise sections: **Project Goal**, **Deliverable / API contract**, **Hard Constraints** (with licensing called out), and **Working Process**.
2. Point future sessions to `TASK.md` as the source of truth for the task and its step ordering.
3. Note that no build/lint/test commands exist yet — to be added once the toolchain (likely `package.json` + a test runner) is established. Avoid inventing commands.

## Out of scope

- No research into actual PDF libraries yet (that is Task step 1 in `TASK.md`, to be done after `/init`, with user approval at each step).
- No source files, `package.json`, or tooling created.

## Verification

- `CLAUDE.md` exists at repo root and opens with the mandated `# CLAUDE.md ...` header block.
- Content is accurate to `TASK.md` (no invented commands, no fabricated architecture).
- Licensing constraint and the "wait for approval at each step" rule are both present and prominent.
