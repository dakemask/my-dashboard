# Agent Guide

## Project Overview

This repository is a personal dashboard for multiple small, user-owned tools. Each tool should live as a separate feature module while sharing the same dashboard entry page, build system, and deployment pipeline.

The app is deployed to GitHub Pages. Source code stays in the repository; GitHub Actions runs a workflow that installs dependencies, builds the Vite output in GitHub Pages' temporary working directory, and deploys the generated artifact to Pages. The local `dist/` directory is only for local testing and is not uploaded to GitHub.

Persistent private data is stored outside this app repository. Modules that need persistence should read and write JSON files in a user-owned private GitHub repository through the GitHub Contents API. This keeps the dashboard app deployable as static files while keeping personal data separate from the public Pages site.

## Development Principles

1. Keep modules decoupled early. When logic starts mixing independent responsibilities, extract it before it becomes a large file problem, and prefer small, typed modules. Common boundaries include UI rendering, browser storage, remote API access, data normalization, pure domain operations, and page-level orchestration.

2. Ask before making important choices. If you encounter:

- User requirements that have several different solutions, where the different options significantly affect later real-world operations;
- Unclear user requirements;
- User requirements that need major project changes.

Use the custom user-input tool before editing. Do not silently choose for the user in those cases.

3. Preserve public behavior unless the user explicitly asks to change it. Existing routes, localStorage keys, JSON data shapes, and deployment assumptions should be treated as compatibility surfaces.

4. TypeScript types should describe persisted data, settings, API responses, and module contracts. Avoid `any` unless there is a clear boundary where unknown external data is being validated.

5. Use safe DOM patterns. Render user-provided content with `textContent` or explicit DOM nodes instead of HTML string templates.

## Current Feature Modules

### Fragment Thoughts

Route: `/modules/thoughts/`

This module lets the user quickly record short thoughts, attach optional tags, and search locally in the loaded list.

## Architecture

The app is a Vite multi-page TypeScript project. HTML files define stable public page shells, while TypeScript under `src/` provides behavior and styling imports.

Important paths:

- `index.html`: dashboard home page shell.
- `modules/thoughts/index.html`: Fragment Thoughts page shell. Keep this route stable.
- `src/home/`: dashboard home page implementation.
- `src/home/modules.ts`: registry of dashboard modules shown on the home page.
- `src/shared/`: utilities that are small and genuinely shared across modules.
- `src/thoughts/`: Fragment Thoughts module implementation.
- `vite.config.ts`: Vite build configuration and multi-page inputs.
- `.github/workflows/pages.yml`: GitHub Pages deployment workflow.

When adding a new feature module, keep the same pattern:

- Add a stable HTML shell under `modules/<module-id>/index.html`.
- Add module source under `src/<module-id>/`.
- Register the module in `src/home/modules.ts`.
- Add the HTML entry to `vite.config.ts` so production builds include it.
- Keep module-specific storage, API clients, data operations, rendering, and orchestration separated.

## Code Responsibilities

For feature modules, use clear responsibility layers rather than a single page script:

- Settings/storage layer: browser persistence such as localStorage keys and defaults.
- API layer: remote service calls, headers, API-specific errors, and request/response types.
- Repository layer: load/save use cases, JSON parsing, validation, and backward-compatible normalization.
- Domain layer: pure operations on module data, such as create, update, delete, filter, sort, and parse.
- View layer: DOM lookup, rendering, and UI state updates.
- Page controller: event wiring and orchestration between the other layers.

The thoughts module currently follows this structure:

- `src/thoughts/settings.ts`
- `src/thoughts/githubContentApi.ts`
- `src/thoughts/thoughtRepository.ts`
- `src/thoughts/notes.ts`
- `src/thoughts/view.ts`
- `src/thoughts/main.ts`

Avoid importing view code into pure data modules, and avoid calling GitHub or localStorage APIs from rendering code.

## GitHub Pages Deployment

Deployment is workflow-based:

1. Code is pushed to `main`, or the workflow is started manually from GitHub Actions.
2. GitHub Actions checks out the source.
3. It installs dependencies with `npm ci`.
4. It runs `npm run build`.
5. It uploads `dist/` as a Pages artifact.
6. It deploys that artifact to GitHub Pages.

The repository settings must use:

`Settings -> Pages -> Build and deployment -> Source -> GitHub Actions`

The Vite `base` path is derived from `GITHUB_REPOSITORY` during Actions builds, so this repository deploys under `/my-dashboard/`. If the repository name changes, verify the generated asset paths before deploying.

## Private JSON Data Repository

Private user data is not stored in this dashboard repository. For modules that need persistence:

- Store data as JSON files in a separate private GitHub repository.
- Access those files from the browser through GitHub's Contents API.
- Use a fine-grained token limited to the private data repository and Contents read/write access.
- Store the token only in the user's browser settings.
- Treat the JSON format as a compatibility contract. If the format needs to change, ask the user first.

## Checks And Testing

Use these commands for code-level verification:

- `npm install`: install dependencies when needed.
- `npm run build`: required before handing off code changes. This runs TypeScript checking and the production Vite build.
- `npm run preview`: optional production preview only when the user explicitly asks for it.

`npm run dev`, browser-based runtime testing, layout review, and user acceptance testing are the user's responsibility. Do not start the development server yourself.
