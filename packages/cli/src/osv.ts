/**
 * Dependency-vulnerability lookup via OSV.dev - CLI's own copy of
 * apps/web/src/lib/osv.ts's logic. Duplicated rather than shared: this
 * package has no dependency on apps/web (and shouldn't gain one just for
 * this), and packages/core can't host it either since it forbids network
 * calls - see that file's own doc comment for the full reasoning, identical
 * here. Keep the two in sync if the OSV integration changes.
 */
import type { DeclaredDependency, DependencyVulnerability, DependencyVulnScanResult, DependencySeverity } from '@archsetu/core';

const OSV_API_BASE = 'https://api.osv.dev/v1';
const QUERYBATCH_CHUNK_SIZE = 500;
const MAX_VULN_DETAILS_TO_FETCH = 150;
const DETAIL_FETCH_CONCURRENCY = 8;
const REQUEST_TIMEOUT_MS = 20 * 1000;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface OsvQueryBatchResponse {
  results: Array<{ vulns?: Array<{ id: string; modified: string }> }>;
}

interface OsvAffectedEvent {
  introduced?: string;
  fixed?: string;
}

interface OsvVulnDetail {
  id: string;
  summary?: string;
  details?: string;
  database_specific?: { severity?: string };
  references?: Array<{ type: string; url: string }>;
  affected?: Array<{
    package?: { name: string; ecosystem: string };
    ranges?: Array<{ events?: OsvAffectedEvent[] }>;
  }>;
}

function mapSeverity(dbSeverity: string | undefined): DependencySeverity {
  switch ((dbSeverity ?? '').toUpperCase()) {
    case 'CRITICAL':
      return 'critical';
    case 'HIGH':
      return 'high';
    case 'MODERATE':
    case 'MEDIUM':
      return 'medium';
    case 'LOW':
      return 'low';
    default:
      return 'unknown';
  }
}

function extractFixedVersion(vuln: OsvVulnDetail, packageName: string, ecosystem: string): string | null {
  for (const affected of vuln.affected ?? []) {
    if (affected.package?.name !== packageName || affected.package?.ecosystem !== ecosystem) continue;
    for (const range of affected.ranges ?? []) {
      for (const event of range.events ?? []) {
        if (event.fixed) return event.fixed;
      }
    }
  }
  return null;
}

async function fetchVulnDetail(id: string): Promise<OsvVulnDetail | null> {
  try {
    const res = await fetchWithTimeout(`${OSV_API_BASE}/vulns/${encodeURIComponent(id)}`, { method: 'GET' });
    if (!res.ok) return null;
    return (await res.json()) as OsvVulnDetail;
  } catch {
    return null;
  }
}

async function fetchVulnDetailsWithConcurrencyLimit(ids: string[]): Promise<Map<string, OsvVulnDetail>> {
  const details = new Map<string, OsvVulnDetail>();
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      if (!id) continue;
      const detail = await fetchVulnDetail(id);
      if (detail) details.set(id, detail);
    }
  }

  await Promise.all(Array.from({ length: Math.min(DETAIL_FETCH_CONCURRENCY, ids.length) }, () => worker()));
  return details;
}

export async function checkDependencyVulnerabilities(deps: DeclaredDependency[]): Promise<DependencyVulnScanResult | null> {
  if (deps.length === 0) {
    return { vulnerabilities: [], dependenciesScanned: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0 };
  }

  try {
    const matchedIdsByDepIndex: string[][] = new Array(deps.length).fill(null).map(() => []);
    for (let chunkStart = 0; chunkStart < deps.length; chunkStart += QUERYBATCH_CHUNK_SIZE) {
      const chunk = deps.slice(chunkStart, chunkStart + QUERYBATCH_CHUNK_SIZE);
      const res = await fetchWithTimeout(`${OSV_API_BASE}/querybatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          queries: chunk.map((d) => ({ package: { name: d.name, ecosystem: d.ecosystem }, version: d.version })),
        }),
      });
      if (!res.ok) continue;

      const json = (await res.json()) as OsvQueryBatchResponse;
      json.results.forEach((result, i) => {
        const depIndex = chunkStart + i;
        for (const vuln of result.vulns ?? []) {
          matchedIdsByDepIndex[depIndex]?.push(vuln.id);
        }
      });
    }

    const uniqueIds = Array.from(new Set(matchedIdsByDepIndex.flat())).slice(0, MAX_VULN_DETAILS_TO_FETCH);
    if (uniqueIds.length === 0) {
      return { vulnerabilities: [], dependenciesScanned: deps.length, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0 };
    }

    const details = await fetchVulnDetailsWithConcurrencyLimit(uniqueIds);

    const vulnerabilities: DependencyVulnerability[] = [];
    deps.forEach((dep, i) => {
      for (const vulnId of matchedIdsByDepIndex[i] ?? []) {
        const detail = details.get(vulnId);
        if (!detail) continue;
        vulnerabilities.push({
          packageName: dep.name,
          version: dep.version,
          ecosystem: dep.ecosystem,
          vulnId,
          summary: detail.summary ?? detail.details?.slice(0, 300) ?? 'No summary available.',
          severity: mapSeverity(detail.database_specific?.severity),
          fixedVersion: extractFixedVersion(detail, dep.name, dep.ecosystem),
          referenceUrl: detail.references?.find((r) => r.type === 'ADVISORY')?.url ?? detail.references?.[0]?.url ?? null,
        });
      }
    });

    let criticalCount = 0, highCount = 0, mediumCount = 0, lowCount = 0;
    for (const v of vulnerabilities) {
      if (v.severity === 'critical') criticalCount++;
      else if (v.severity === 'high') highCount++;
      else if (v.severity === 'medium') mediumCount++;
      else if (v.severity === 'low') lowCount++;
    }

    return { vulnerabilities, dependenciesScanned: deps.length, criticalCount, highCount, mediumCount, lowCount };
  } catch (err) {
    console.error('[osv] Dependency vulnerability check failed:', (err as Error).message);
    return null;
  }
}
