/**
 * Kubernetes manifest connector (Wave 2b).
 *
 * Reads a workload manifest YAML from `config.connectors.k8s.manifestsDir`,
 * locates a container's `resources.requests`/`limits.memory`, and produces an
 * edited YAML string with a new memory request. Uses the `yaml` package's
 * document API so surrounding structure, key order, and comments are preserved.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { isMap, isSeq, parseDocument } from 'yaml';

import type { RunContext } from '../../contracts/index.js';

/** Memory request/limit currently declared for a container. */
export interface ContainerMemory {
  request?: string;
  limit?: string;
}

/** Result of editing a manifest's memory request. */
export interface ManifestEdit {
  /** Full edited YAML content (suitable for a FileChange.newContent). */
  content: string;
  /** The previous request value that was replaced, if present. */
  previousRequest?: string;
}

/** Repo-relative path to a workload manifest (posix-style for the PR). */
export function manifestRepoPath(ctx: RunContext, manifestPath: string): string {
  const dir = ctx.config.connectors.k8s.manifestsDir.replace(/\/+$/u, '');
  return `${dir}/${manifestPath}`;
}

/** Read the raw YAML text for a workload manifest. */
export async function readManifest(
  ctx: RunContext,
  manifestPath: string,
): Promise<string> {
  const absPath = resolve(ctx.config.connectors.k8s.manifestsDir, manifestPath);
  return readFile(absPath, 'utf8');
}

/** Read a container's currently-declared memory request/limit from YAML. */
export function readContainerMemory(
  yamlText: string,
  container: string,
): ContainerMemory {
  const doc = parseDocument(yamlText);
  const path = findContainerPath(doc, container);
  if (path === null) return {};
  const request = doc.getIn([...path, 'resources', 'requests', 'memory']);
  const limit = doc.getIn([...path, 'resources', 'limits', 'memory']);
  return {
    ...(request === undefined || request === null ? {} : { request: String(request) }),
    ...(limit === undefined || limit === null ? {} : { limit: String(limit) }),
  };
}

/**
 * Produce an edited YAML string that sets the container's memory request to
 * `newRequest`, preserving the rest of the document. Throws if the container or
 * its `resources.requests` block cannot be found.
 */
export function editManifestMemoryRequest(
  yamlText: string,
  container: string,
  newRequest: string,
): ManifestEdit {
  const doc = parseDocument(yamlText);
  const path = findContainerPath(doc, container);
  if (path === null) {
    throw new Error(`container ${JSON.stringify(container)} not found in manifest`);
  }
  const requestPath = [...path, 'resources', 'requests', 'memory'];
  const previous = doc.getIn(requestPath);
  if (previous === undefined || previous === null) {
    throw new Error(
      `container ${JSON.stringify(container)} has no resources.requests.memory`,
    );
  }
  doc.setIn(requestPath, newRequest);
  return {
    content: String(doc),
    previousRequest: String(previous),
  };
}

/**
 * Locate the document path to a named container under
 * `spec.template.spec.containers`. Returns null if not found.
 */
function findContainerPath(
  doc: ReturnType<typeof parseDocument>,
  container: string,
): Array<string | number> | null {
  const containers = doc.getIn(['spec', 'template', 'spec', 'containers']);
  if (!isSeq(containers)) return null;
  for (let i = 0; i < containers.items.length; i += 1) {
    const item = containers.items[i];
    if (isMap(item) && item.get('name') === container) {
      return ['spec', 'template', 'spec', 'containers', i];
    }
  }
  return null;
}
