/**
 * ============================ LOCKED CONTRACT SURFACE ============================
 * Single import point for all shared contracts. Wave 2 imports from here.
 *
 * THESE CONTRACTS ARE LOCKED. Wave 2 (dbt / k8s / orchestration) MUST NOT
 * change anything under `src/contracts/**` without explicit Lead approval.
 * See CONTRACTS.md for ownership and the factory signatures to implement.
 * ================================================================================
 */

export * from './findings.js';
export * from './pr.js';
export * from './pipeline.js';
export * from './config.js';

// Re-export the Logger contract so consumers get the full surface from one place.
export type { Logger, LogLevel, LogFields } from '../core/logger.js';
