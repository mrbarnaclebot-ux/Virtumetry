---
phase: 03-owner-account-scan-library
plan: 01
subsystem: supply-chain
tags: [packages, legitimacy]
requires: []
provides: [approved package list for 03-02 and 03-05]
affects: [backend/package.json, virtumetry/package.json]
key-files:
  created: []
  modified: []
duration: 2min
completed: 2026-11-24
---

# Phase 3 Plan 01: Package legitimacy gate — Summary

Read-only `npm view <pkg> repository.url scripts.postinstall scripts.install` for every Phase 3 package. All **approved**: each repository URL is the official upstream and none declares an install/postinstall script. Nothing installed in this plan.

| Package | Version | Repository | Install script |
|---------|---------|------------|----------------|
| better-auth | 1.7.27 | github.com/better-auth/better-auth | none |
| @better-auth/expo | 1.7.27 | github.com/better-auth/better-auth | none |
| @fastify/cors | 11.4.3 | github.com/fastify/fastify-cors | none |
| @tanstack/react-query | 5.108.x | github.com/TanStack/query | none |
| expo-secure-store | ~58.0.3 | github.com/expo/expo | none |
| expo-network | ~58.0.5 | github.com/expo/expo | none |
| jest-expo | ~58.0.15 | github.com/expo/expo | none |
| jest | 30.x | github.com/jestjs/jest | none |
| @types/jest | 30.x | github.com/DefinitelyTyped/DefinitelyTyped | none |
| @testing-library/react-native | 14.1.x | github.com/callstack/react-native-testing-library | none |

## Deviations from Plan
Run by the orchestrator inline (autonomous mode); no owner checkpoint per the owner's fully-autonomous instruction.

## Self-Check: PASSED
