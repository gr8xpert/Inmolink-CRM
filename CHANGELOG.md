# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Monorepo scaffold: pnpm workspace + Turborepo with every app and package from PLAN §5.7 as a building skeleton, strict TypeScript/Biome/Vitest presets in `@inmolink/config`, husky + lint-staged, `pnpm verify` (Turbo `--affected`), stubbed root scripts for later tasks, and ADR 0001 with pinned versions. New dev dependencies: turbo, @biomejs/biome, typescript, vitest, tsdown, tsx, husky, lint-staged, @types/node; next, react, react-dom in the Next.js apps. [S0-01]
