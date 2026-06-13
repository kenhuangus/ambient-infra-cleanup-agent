/**
 * File-backed StateStore (Wave 2c).
 *
 * Persists known findings to `<stateDir>/findings.json` for dedup + lifecycle
 * tracking across runs. `record` upserts by `findingId` (preserving
 * `firstSeenAt`, updating `lastSeenAt`); `markState` transitions lifecycle.
 *
 * The store is intentionally simple (read-modify-write of a single JSON file).
 * It is sufficient for the MVP's single-process background runner.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  FindingState,
  KnownFinding,
  StateStore,
} from '../contracts/index.js';

/** Create a JSON-file-backed StateStore rooted at `stateDir`. */
export function createStateStore(stateDir = '.agent-state'): StateStore {
  const file = join(stateDir, 'findings.json');

  async function load(): Promise<Map<string, KnownFinding>> {
    const map = new Map<string, KnownFinding>();
    if (!existsSync(file)) return map;
    const raw = await readFile(file, 'utf8');
    if (raw.trim() === '') return map;
    const parsed = JSON.parse(raw) as KnownFinding[];
    for (const entry of parsed) {
      map.set(entry.findingId, entry);
    }
    return map;
  }

  async function persist(map: Map<string, KnownFinding>): Promise<void> {
    await mkdir(stateDir, { recursive: true });
    const entries = [...map.values()];
    await writeFile(file, JSON.stringify(entries, null, 2), 'utf8');
  }

  return {
    async getKnown(): Promise<KnownFinding[]> {
      const map = await load();
      return [...map.values()];
    },

    async get(findingId: string): Promise<KnownFinding | undefined> {
      const map = await load();
      return map.get(findingId);
    },

    async record(entries: KnownFinding[]): Promise<void> {
      const map = await load();
      for (const entry of entries) {
        const existing = map.get(entry.findingId);
        // Upsert: new values win, but firstSeenAt is preserved from the
        // earliest sighting and lastSeenAt always advances to this entry.
        const merged: KnownFinding = {
          ...existing,
          ...entry,
          firstSeenAt: existing?.firstSeenAt ?? entry.firstSeenAt,
          lastSeenAt: entry.lastSeenAt,
        };
        map.set(entry.findingId, merged);
      }
      await persist(map);
    },

    async markState(
      findingId: string,
      state: FindingState,
      notes?: string,
    ): Promise<void> {
      const map = await load();
      const existing = map.get(findingId);
      if (existing === undefined) return;
      map.set(findingId, {
        ...existing,
        state,
        ...(notes === undefined ? {} : { notes }),
      });
      await persist(map);
    },
  };
}
