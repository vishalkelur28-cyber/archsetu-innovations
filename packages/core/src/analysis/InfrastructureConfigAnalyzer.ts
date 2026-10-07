import { parseAllDocuments, LineCounter, isMap, isSeq, isScalar } from 'yaml';
import type { YAMLMap, YAMLSeq, Node } from 'yaml';
import type { SecurityFinding } from './SecurityRiskAnalyzer.js';

/**
 * Structural misconfiguration scanning for infrastructure-as-code: Kubernetes
 * manifests, Docker Compose files, and GitHub Actions workflows (all YAML),
 * plus an extended Terraform pass. Same "well-established anti-pattern, worth
 * a human look" contract as SecurityRiskAnalyzer.ts, not a real OPA/kube-bench
 * policy engine or HCL AST - a lightweight structural walk over the parsed
 * YAML tree (via the `yaml` package) for the YAML-flavored checks, and a
 * brace-depth-tracked regex scan for Terraform, the same tradeoff
 * SecurityRiskAnalyzer.ts already makes for source code.
 *
 * Every check here is deliberately conservative about false positives -
 * gated on the specific, well-known idiom (a boolean literal, a wildcard
 * string, a specific block type) rather than "best practice" heuristics like
 * "no resource limits set", which would fire on the majority of manifests in
 * the wild and drown out the findings that actually matter.
 */

function lineFromOffset(lineCounter: LineCounter, offset: number): number {
  return lineCounter.linePos(offset).line;
}

function scalarValue(node: Node | undefined): unknown {
  if (!node) return undefined;
  return isScalar(node) ? node.value : undefined;
}

function nodeOffset(node: Node | undefined): number {
  return node?.range?.[0] ?? 0;
}

function truncate(text: string): string {
  return text.trim().slice(0, 200);
}

// ─── Kubernetes ─────────────────────────────────────────────────────────────

const DANGEROUS_CAPABILITIES = new Set(['ALL', 'SYS_ADMIN', 'NET_ADMIN', 'SYS_PTRACE', 'SYS_MODULE']);

/**
 * Walks the whole document tree looking for pod/container-level fields by
 * key name alone, not by following a specific kind's exact nesting path
 * (Pod, Deployment, StatefulSet, DaemonSet, Job, and CronJob all wrap a
 * PodSpec at a different depth) - a generic walk is what actually stays
 * correct across all of them without hard-coding every kind's shape.
 */
function walkForKubernetesFindings(
  node: Node,
  filePath: string,
  lineCounter: LineCounter,
  findings: SecurityFinding[],
): void {
  if (isSeq(node)) {
    for (const item of node.items) {
      if (item && typeof item === 'object' && 'range' in (item as object)) walkForKubernetesFindings(item as Node, filePath, lineCounter, findings);
    }
    return;
  }
  if (!isMap(node)) return;
  const map = node as YAMLMap;

  const privileged = map.get('privileged', true) as Node | undefined;
  if (scalarValue(privileged) === true) {
    findings.push({
      category: 'container-misconfiguration',
      severity: 'high',
      filePath,
      line: lineFromOffset(lineCounter, nodeOffset(privileged)),
      description: 'Container runs with privileged: true, giving it near-full access to the host - equivalent to root on the node itself.',
      lineText: 'privileged: true',
    });
  }

  for (const key of ['hostNetwork', 'hostPID', 'hostIPC'] as const) {
    const value = map.get(key, true) as Node | undefined;
    if (scalarValue(value) === true) {
      findings.push({
        category: 'container-misconfiguration',
        severity: 'high',
        filePath,
        line: lineFromOffset(lineCounter, nodeOffset(value)),
        description: `Pod sets ${key}: true, sharing the host's ${key === 'hostNetwork' ? 'network' : key === 'hostPID' ? 'process' : 'IPC'} namespace and breaking container isolation from the node.`,
        lineText: `${key}: true`,
      });
    }
  }

  const capabilities = map.get('capabilities', true) as YAMLMap | undefined;
  if (isMap(capabilities)) {
    const add = capabilities.get('add', true) as YAMLSeq | undefined;
    if (isSeq(add)) {
      for (const item of add.items) {
        const value = isScalar(item) ? item.value : undefined;
        if (typeof value === 'string' && DANGEROUS_CAPABILITIES.has(value.toUpperCase())) {
          findings.push({
            category: 'container-misconfiguration',
            severity: 'high',
            filePath,
            line: lineFromOffset(lineCounter, nodeOffset(item as Node)),
            description: `Container adds the ${value} Linux capability - broad enough to escape typical container isolation (kernel module loading, ptrace on other processes, or full privilege depending on the exact capability).`,
            lineText: `capabilities.add: [${value}]`,
          });
        }
      }
    }
  }

  const hostPath = map.get('hostPath', true) as YAMLMap | undefined;
  if (isMap(hostPath) && hostPath.has('path')) {
    findings.push({
      category: 'container-misconfiguration',
      severity: 'medium',
      filePath,
      line: lineFromOffset(lineCounter, nodeOffset(hostPath)),
      description: 'Volume mounts a path from the host filesystem (hostPath) into the container - depending on the path, this can be used to read host files or escape container isolation.',
      lineText: 'hostPath volume',
    });
  }

  // Container-shaped map: both `name` and `image` present as sibling scalars.
  const name = map.get('name', false);
  const image = map.get('image', true) as Node | undefined;
  const imageValue = scalarValue(image);
  if (typeof name === 'string' && typeof imageValue === 'string' && isUnpinnedImageTag(imageValue)) {
    findings.push({
      category: 'container-misconfiguration',
      severity: 'medium',
      filePath,
      line: lineFromOffset(lineCounter, nodeOffset(image)),
      description: `Container image "${imageValue}" uses an unpinned tag (:latest or none) - the same manifest can deploy a different image tomorrow with no code change to review or roll back to.`,
      lineText: `image: ${imageValue}`,
    });
  }

  for (const pair of map.items) {
    const value = pair.value;
    if (value && typeof value === 'object' && 'range' in (value as object)) walkForKubernetesFindings(value as Node, filePath, lineCounter, findings);
  }
}

function isUnpinnedImageTag(image: string): boolean {
  if (image.includes('@sha256:')) return false; // digest-pinned - as pinned as it gets.
  const afterLastSlash = image.slice(image.lastIndexOf('/') + 1);
  if (!afterLastSlash.includes(':')) return true; // no tag at all - defaults to :latest.
  return afterLastSlash.endsWith(':latest');
}

function scanKubernetesRbac(map: YAMLMap, filePath: string, lineCounter: LineCounter, findings: SecurityFinding[]): void {
  const kind = scalarValue(map.get('kind', true) as Node | undefined);
  if (kind !== 'Role' && kind !== 'ClusterRole') return;

  const rules = map.get('rules', true) as YAMLSeq | undefined;
  if (!isSeq(rules)) return;

  for (const rule of rules.items) {
    if (!isMap(rule)) continue;
    const resources = rule.get('resources', true) as YAMLSeq | undefined;
    const verbs = rule.get('verbs', true) as YAMLSeq | undefined;
    const hasWildcardResource = isSeq(resources) && resources.items.some((i) => isScalar(i) && i.value === '*');
    const hasWildcardVerb = isSeq(verbs) && verbs.items.some((i) => isScalar(i) && i.value === '*');
    if (hasWildcardResource && hasWildcardVerb) {
      findings.push({
        category: 'container-misconfiguration',
        severity: 'high',
        filePath,
        line: lineFromOffset(lineCounter, nodeOffset(rule)),
        description: `${kind} grants resources: ["*"] with verbs: ["*"] - unrestricted access to every resource type and every action, equivalent to cluster-admin for whatever this role is bound to.`,
        lineText: 'resources: ["*"], verbs: ["*"]',
      });
    }
  }
}

// ─── Docker Compose ─────────────────────────────────────────────────────────

function scanComposeDoc(map: YAMLMap, filePath: string, lineCounter: LineCounter, findings: SecurityFinding[]): void {
  const services = map.get('services', true) as YAMLMap | undefined;
  if (!isMap(services)) return;

  for (const pair of services.items) {
    const service = pair.value;
    if (!isMap(service)) continue;
    const serviceName = isScalar(pair.key) ? String(pair.key.value) : 'service';

    const privileged = service.get('privileged', true) as Node | undefined;
    if (scalarValue(privileged) === true) {
      findings.push({
        category: 'container-misconfiguration',
        severity: 'high',
        filePath,
        line: lineFromOffset(lineCounter, nodeOffset(privileged)),
        description: `Compose service "${serviceName}" runs with privileged: true, giving it near-full access to the host.`,
        lineText: 'privileged: true',
      });
    }

    const networkMode = service.get('network_mode', true) as Node | undefined;
    if (scalarValue(networkMode) === 'host') {
      findings.push({
        category: 'container-misconfiguration',
        severity: 'high',
        filePath,
        line: lineFromOffset(lineCounter, nodeOffset(networkMode)),
        description: `Compose service "${serviceName}" uses network_mode: host, sharing the host's network namespace and bypassing normal container network isolation.`,
        lineText: 'network_mode: host',
      });
    }

    const capAdd = service.get('cap_add', true) as YAMLSeq | undefined;
    if (isSeq(capAdd)) {
      for (const item of capAdd.items) {
        const value = isScalar(item) ? item.value : undefined;
        if (typeof value === 'string' && DANGEROUS_CAPABILITIES.has(value.toUpperCase())) {
          findings.push({
            category: 'container-misconfiguration',
            severity: 'high',
            filePath,
            line: lineFromOffset(lineCounter, nodeOffset(item as Node)),
            description: `Compose service "${serviceName}" adds the ${value} Linux capability.`,
            lineText: `cap_add: [${value}]`,
          });
        }
      }
    }

    const volumes = service.get('volumes', true) as YAMLSeq | undefined;
    if (isSeq(volumes)) {
      for (const item of volumes.items) {
        const text = isScalar(item) ? String(item.value ?? '') : '';
        if (text.includes('/var/run/docker.sock')) {
          findings.push({
            category: 'container-misconfiguration',
            severity: 'high',
            filePath,
            line: lineFromOffset(lineCounter, nodeOffset(item as Node)),
            description: `Compose service "${serviceName}" mounts the Docker socket (/var/run/docker.sock) - this gives the container root-equivalent control over the host, since it can use the socket to launch new privileged containers of its own.`,
            lineText: truncate(text),
          });
        }
      }
    }

    const image = service.get('image', true) as Node | undefined;
    const imageValue = scalarValue(image);
    if (typeof imageValue === 'string' && isUnpinnedImageTag(imageValue)) {
      findings.push({
        category: 'container-misconfiguration',
        severity: 'medium',
        filePath,
        line: lineFromOffset(lineCounter, nodeOffset(image)),
        description: `Compose service "${serviceName}" uses image "${imageValue}" with an unpinned tag (:latest or none).`,
        lineText: `image: ${imageValue}`,
      });
    }
  }
}

// ─── GitHub Actions ─────────────────────────────────────────────────────────

/**
 * Untrusted event data interpolated directly into a shell `run:` step is a
 * real, repeatedly-exploited GitHub Actions vulnerability class (GitHub's
 * own security lab has published multiple advisories on exactly this
 * pattern) - a crafted issue title, PR title, or branch name becomes
 * arbitrary shell in the runner. The fix is always the same: pass it through
 * `env:` and reference the env var instead of inlining the expression.
 */
const UNTRUSTED_EXPRESSION_PATTERN =
  /\$\{\{\s*(?:github\.event\.(?:issue\.(?:title|body)|pull_request\.(?:title|body|head\.(?:ref|label))|comment\.body|review\.body|discussion\.(?:title|body))|github\.head_ref)\s*\}\}/;

function scanGithubActionsDoc(map: YAMLMap, filePath: string, lineCounter: LineCounter, findings: SecurityFinding[]): void {
  const onNode = map.get('on', true) as Node | undefined;
  const jobs = map.get('jobs', true) as YAMLMap | undefined;
  if (!isMap(jobs)) return; // not actually a workflow file - just YAML that happens to live under .github/workflows/

  const triggers = new Set<string>();
  if (isScalar(onNode)) { if (typeof onNode.value === 'string') triggers.add(onNode.value); }
  else if (isSeq(onNode)) { for (const t of onNode.items) if (isScalar(t) && typeof t.value === 'string') triggers.add(t.value); }
  else if (isMap(onNode)) { for (const pair of onNode.items) if (isScalar(pair.key) && typeof pair.key.value === 'string') triggers.add(pair.key.value); }

  const permissions = map.get('permissions', true) as Node | undefined;
  if (scalarValue(permissions) === 'write-all') {
    findings.push({
      category: 'ci-workflow-injection',
      severity: 'medium',
      filePath,
      line: lineFromOffset(lineCounter, nodeOffset(permissions)),
      description: 'Workflow requests permissions: write-all - every token scope gets write access. Scope permissions down to only what each job actually needs.',
      lineText: 'permissions: write-all',
    });
  }

  const isPullRequestTarget = triggers.has('pull_request_target');

  const walkSteps = (node: Node): void => {
    if (isSeq(node)) { for (const item of node.items) if (item && typeof item === 'object' && 'range' in (item as object)) walkSteps(item as Node); return; }
    if (!isMap(node)) return;

    const run = node.get('run', true) as Node | undefined;
    const runText = scalarValue(run);
    if (typeof runText === 'string' && UNTRUSTED_EXPRESSION_PATTERN.test(runText)) {
      findings.push({
        category: 'ci-workflow-injection',
        severity: 'high',
        filePath,
        line: lineFromOffset(lineCounter, nodeOffset(run)),
        description: 'Untrusted event data (an issue/PR title, body, branch name, or comment) is interpolated directly into a shell command - a crafted value can inject arbitrary shell into this step. Pass it through env: and reference the env var instead of inlining the expression.',
        lineText: truncate(runText.split('\n')[0] ?? runText),
      });
    }

    if (isPullRequestTarget) {
      const uses = scalarValue(node.get('uses', true) as Node | undefined);
      if (typeof uses === 'string' && uses.startsWith('actions/checkout')) {
        const withNode = node.get('with', true) as YAMLMap | undefined;
        const ref = isMap(withNode) ? scalarValue(withNode.get('ref', true) as Node | undefined) : undefined;
        if (typeof ref === 'string' && /github\.event\.pull_request\.head/.test(ref)) {
          findings.push({
            category: 'ci-workflow-injection',
            severity: 'high',
            filePath,
            line: lineFromOffset(lineCounter, nodeOffset(node)),
            description: 'pull_request_target runs with the base repo\'s secrets, but this step checks out the fork\'s own head ref/sha - a fork PR can then run its own code (via a later build/test step) with access to those secrets. Either avoid pull_request_target for this workflow, or never check out or execute untrusted head content under it.',
            lineText: `ref: ${ref}`,
          });
        }
      }
    }

    for (const pair of node.items) {
      const value = pair.value;
      if (value && typeof value === 'object' && 'range' in (value as object)) walkSteps(value as Node);
    }
  };

  walkSteps(jobs);
}

// ─── YAML entry point ───────────────────────────────────────────────────────

function detectYamlFlavor(filePath: string, map: YAMLMap): 'kubernetes' | 'compose' | 'github-actions' | null {
  if (isScalar(map.get('kind', true)) && isScalar(map.get('apiVersion', true))) return 'kubernetes';
  if (isMap(map.get('services', true))) return 'compose';
  // Normalize backslashes first - on Windows, filePath uses \, and this
  // check would silently never match without it (confirmed directly: the
  // hosted worker clones repos on Linux, but the CLI and local dev both run
  // this same code on Windows).
  const normalized = filePath.toLowerCase().replace(/\\/g, '/');
  if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(normalized) && isMap(map.get('jobs', true))) return 'github-actions';
  return null;
}

export function scanYamlInfraConfig(filePath: string, content: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const lineCounter = new LineCounter();
  let docs;
  try {
    docs = parseAllDocuments(content, { lineCounter });
  } catch {
    return findings; // malformed YAML - not this scanner's job to report syntax errors.
  }

  for (const doc of docs) {
    if (doc.errors.length > 0) continue; // don't guess at findings in a document that didn't actually parse cleanly.
    const map = doc.contents;
    if (!isMap(map)) continue;

    const flavor = detectYamlFlavor(filePath, map);
    if (flavor === 'kubernetes') {
      walkForKubernetesFindings(map, filePath, lineCounter, findings);
      scanKubernetesRbac(map, filePath, lineCounter, findings);
    } else if (flavor === 'compose') {
      scanComposeDoc(map, filePath, lineCounter, findings);
    } else if (flavor === 'github-actions') {
      scanGithubActionsDoc(map, filePath, lineCounter, findings);
    }
  }

  return findings;
}

// ─── Terraform ──────────────────────────────────────────────────────────────

/**
 * Lightweight brace-depth tracking, not a real HCL parser - same tradeoff as
 * every other regex-based scan in this package. Good enough to tell "this
 * cidr_blocks line is inside an ingress block, not egress" (egress to
 * 0.0.0.0/0 is normal and would be pure noise) and "this Action/Resource
 * wildcard pair is inside an aws_iam_*policy resource block", both of which
 * a flat whole-file regex can't distinguish.
 */
const BLOCK_OPENER = /^\s*(ingress|egress)\s*\{/;
const RESOURCE_OPENER = /^\s*resource\s+"([\w]+)"\s+"[\w-]+"\s*\{/;
const BLOCK_CLOSER = /^\s*\}\s*$/;

export function scanTerraformInfraConfig(filePath: string, content: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const lines = content.split('\n');
  const blockStack: string[] = [];
  let iamPolicyBlockDepth = -1;
  let sawWildcardAction = false;
  let sawWildcardResource = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    const resourceOpen = RESOURCE_OPENER.exec(line);
    if (resourceOpen) {
      const resourceType = resourceOpen[1] ?? '';
      blockStack.push(`resource:${resourceType}`);
      if (/^aws_iam_(policy|role_policy|group_policy|user_policy)$/.test(resourceType)) {
        iamPolicyBlockDepth = blockStack.length;
        sawWildcardAction = false;
        sawWildcardResource = false;
      }
    } else {
      const blockOpen = BLOCK_OPENER.exec(line);
      if (blockOpen) blockStack.push(blockOpen[1] ?? '');
    }

    const currentBlock = blockStack[blockStack.length - 1];

    if (currentBlock === 'ingress' && /0\.0\.0\.0\/0/.test(line)) {
      findings.push({
        category: 'cloud-exposure',
        severity: 'high',
        filePath,
        line: i + 1,
        description: 'Security group ingress rule allows traffic from 0.0.0.0/0 - open to the entire internet. Scope this to specific known CIDR ranges instead.',
        lineText: truncate(line),
      });
    }

    if (blockStack.includes('resource:aws_s3_bucket') || blockStack.includes('resource:aws_s3_bucket_acl')) {
      const aclMatch = /acl\s*=\s*"(public-read-write|public-read)"/.exec(line);
      if (aclMatch) {
        findings.push({
          category: 'cloud-exposure',
          severity: 'high',
          filePath,
          line: i + 1,
          description: `S3 bucket ACL is set to "${aclMatch[1]}" - the bucket (or its objects) is publicly readable${aclMatch[1] === 'public-read-write' ? ' and writable' : ''} by anyone on the internet.`,
          lineText: truncate(line),
        });
      }
    }

    if (blockStack.some((b) => b === 'resource:aws_db_instance' || b === 'resource:aws_rds_cluster_instance')) {
      if (/publicly_accessible\s*=\s*true/.test(line)) {
        findings.push({
          category: 'cloud-exposure',
          severity: 'high',
          filePath,
          line: i + 1,
          description: 'Database instance sets publicly_accessible = true - reachable directly from the internet rather than only from within the VPC.',
          lineText: truncate(line),
        });
      }
    }

    if (iamPolicyBlockDepth !== -1 && blockStack.length >= iamPolicyBlockDepth) {
      if (/["']?Action["']?\s*[:=]\s*"\*"/.test(line)) sawWildcardAction = true;
      if (/["']?Resource["']?\s*[:=]\s*"\*"/.test(line)) sawWildcardResource = true;
      if (sawWildcardAction && sawWildcardResource) {
        findings.push({
          category: 'cloud-exposure',
          severity: 'high',
          filePath,
          line: i + 1,
          description: 'IAM policy grants Action: "*" with Resource: "*" - unrestricted access to every AWS action on every resource for whatever principal this policy is attached to.',
          lineText: truncate(line),
        });
        sawWildcardAction = false;
        sawWildcardResource = false; // one finding per block is enough signal.
      }
    }

    if (BLOCK_CLOSER.test(line) && blockStack.length > 0) {
      if (blockStack.length === iamPolicyBlockDepth) iamPolicyBlockDepth = -1;
      blockStack.pop();
    }
  }

  return findings;
}

// ─── Dockerfile ─────────────────────────────────────────────────────────────

const FROM_LINE = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+([\w-]+))?/i;
const USER_LINE = /^\s*USER\s+/i;
const ADD_URL_LINE = /^\s*ADD\s+(https?:\/\/\S+)/i;

export function scanDockerfileInfraConfig(filePath: string, content: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const lines = content.split('\n');
  const stageNames = new Set<string>();

  // First pass: collect named stages so a `FROM builder` reference isn't
  // mistaken for an external, unpinned base image.
  for (const line of lines) {
    const m = FROM_LINE.exec(line);
    if (m?.[2]) stageNames.add(m[2]);
  }

  let currentStageHasUser = false;
  let lastFromLine = -1;
  let lastFromImage = '';

  const flushStage = (): void => {
    if (lastFromLine === -1 || currentStageHasUser) return;
    findings.push({
      category: 'container-misconfiguration',
      severity: 'low',
      filePath,
      line: lastFromLine + 1,
      description: `Build stage from "${lastFromImage}" has no USER instruction - the container runs as root by default. Add a USER instruction after installing dependencies to drop to a non-root user.`,
      lineText: `FROM ${lastFromImage}`,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    const fromMatch = FROM_LINE.exec(line);
    if (fromMatch) {
      flushStage();
      const image = fromMatch[1] ?? '';
      currentStageHasUser = false;
      lastFromLine = i;
      lastFromImage = image;

      if (!stageNames.has(image) && isUnpinnedImageTag(image)) {
        findings.push({
          category: 'container-misconfiguration',
          severity: 'medium',
          filePath,
          line: i + 1,
          description: `Base image "${image}" uses an unpinned tag (:latest or none) - the build can silently pull a different image tomorrow. Pin to a specific version or digest.`,
          lineText: truncate(line),
        });
      }
      continue;
    }

    if (USER_LINE.test(line)) currentStageHasUser = true;

    const addMatch = ADD_URL_LINE.exec(line);
    if (addMatch) {
      findings.push({
        category: 'container-misconfiguration',
        severity: 'medium',
        filePath,
        line: i + 1,
        description: `ADD fetches a remote URL (${addMatch[1]}) directly into the image with no integrity check. Prefer curl/wget with a checksum verification step, or COPY a file that's already in the build context.`,
        lineText: truncate(line),
      });
    }
  }
  flushStage();

  return findings;
}
