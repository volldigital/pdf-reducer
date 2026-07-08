# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Goal

Build a JavaScript helper that reduces the file size of user-uploaded PDFs. The PDFs are typically phone "scans" of documents and are therefore large. See `TASK.md` for the authoritative spec.

## Deliverable / API contract

- Single output file: `pdfSizeReducer.js`.
- Exposes one method: `reduce(base64Pdf)` — takes a base64-encoded PDF string and returns a base64-encoded string of the reduced PDF.

## Hard Constraints

- Language: JavaScript.
- Both input and output are base64-encoded strings (not files, buffers, or paths at the public boundary).
- Prefer using libraries over hand-rolled code wherever possible.
- **Licensing is a gating requirement.** This is a commercial application, so copyleft/AGPL-encumbered dependencies are disqualified. Ghostscript (AGPL) is explicitly excluded. Verify every candidate library's license before adopting it.

## Working Process

`TASK.md` defines an ordered, approval-gated workflow. Follow it strictly:

1. Research adequate libraries.
2. Weigh pros and cons of each.
3. Present an overview of resulting approaches with pros/cons for the user to choose from.
4. Refine the chosen approach together with the user.
5. Write an implementation plan.
6. Execute step by step, waiting for approval at each step.

Rules that govern how to work here:

- **Never assume.** Research thoroughly and ask the user when anything is unclear or ambiguous.
- **Never advance a step without explicit approval** of the current one — the user may review results and request changes that affect the remaining plan.
- **Document continuously.** Record progress and every decision, including *why* it was made. When a decision changes, document what changed and why so the reasoning stays auditable.

## Tooling status

No build, lint, or test commands exist yet — there is no `package.json` or toolchain. Add this section with concrete commands once the toolchain is established; do not invent commands before then.