import { describe, it, expect } from 'vitest';
import { scanYamlInfraConfig, scanTerraformInfraConfig, scanDockerfileInfraConfig } from '../InfrastructureConfigAnalyzer.js';

describe('scanYamlInfraConfig - Kubernetes', () => {
  it('flags a privileged container', () => {
    const content = `apiVersion: v1
kind: Pod
metadata:
  name: demo
spec:
  containers:
    - name: app
      image: myrepo/app:1.2.3
      securityContext:
        privileged: true
`;
    const findings = scanYamlInfraConfig('/repo/pod.yaml', content);
    const f = findings.find((x) => x.description.includes('privileged: true'));
    expect(f).toBeDefined();
    expect(f?.category).toBe('container-misconfiguration');
    expect(f?.severity).toBe('high');
    expect(f?.line).toBe(10);
  });

  it('does not flag a container without privileged set', () => {
    const content = `apiVersion: v1
kind: Pod
metadata:
  name: demo
spec:
  containers:
    - name: app
      image: myrepo/app:1.2.3
`;
    const findings = scanYamlInfraConfig('/repo/pod.yaml', content);
    expect(findings.filter((f) => f.description.includes('privileged'))).toHaveLength(0);
  });

  it('flags hostNetwork/hostPID/hostIPC on a pod spec', () => {
    const content = `apiVersion: v1
kind: Pod
metadata:
  name: demo
spec:
  hostNetwork: true
  hostPID: true
  containers:
    - name: app
      image: myrepo/app:1.2.3
`;
    const findings = scanYamlInfraConfig('/repo/pod.yaml', content);
    expect(findings.filter((f) => f.description.includes('hostNetwork') || f.description.includes('hostPID'))).toHaveLength(2);
  });

  it('flags a dangerous added capability', () => {
    const content = `apiVersion: v1
kind: Pod
metadata:
  name: demo
spec:
  containers:
    - name: app
      image: myrepo/app:1.2.3
      securityContext:
        capabilities:
          add: ["SYS_ADMIN"]
`;
    const findings = scanYamlInfraConfig('/repo/pod.yaml', content);
    expect(findings.some((f) => f.description.includes('SYS_ADMIN'))).toBe(true);
  });

  it('does not flag a harmless added capability', () => {
    const content = `apiVersion: v1
kind: Pod
metadata:
  name: demo
spec:
  containers:
    - name: app
      image: myrepo/app:1.2.3
      securityContext:
        capabilities:
          add: ["NET_BIND_SERVICE"]
`;
    const findings = scanYamlInfraConfig('/repo/pod.yaml', content);
    expect(findings).toHaveLength(0);
  });

  it('flags an unpinned :latest image tag on a container', () => {
    const content = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo
spec:
  template:
    spec:
      containers:
        - name: app
          image: myrepo/app:latest
`;
    const findings = scanYamlInfraConfig('/repo/deploy.yaml', content);
    expect(findings.some((f) => f.description.includes('unpinned tag'))).toBe(true);
  });

  it('does not flag a digest-pinned image', () => {
    const content = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo
spec:
  template:
    spec:
      containers:
        - name: app
          image: myrepo/app@sha256:${'a'.repeat(64)}
`;
    const findings = scanYamlInfraConfig('/repo/deploy.yaml', content);
    expect(findings.filter((f) => f.description.includes('unpinned'))).toHaveLength(0);
  });

  it('flags a hostPath volume', () => {
    const content = `apiVersion: v1
kind: Pod
metadata:
  name: demo
spec:
  containers:
    - name: app
      image: myrepo/app:1.2.3
  volumes:
    - name: data
      hostPath:
        path: /var/lib/data
`;
    const findings = scanYamlInfraConfig('/repo/pod.yaml', content);
    expect(findings.some((f) => f.description.includes('hostPath'))).toBe(true);
  });

  it('flags a ClusterRole granting resources:* and verbs:*', () => {
    const content = `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: super-admin
rules:
  - apiGroups: ["*"]
    resources: ["*"]
    verbs: ["*"]
`;
    const findings = scanYamlInfraConfig('/repo/rbac.yaml', content);
    expect(findings.some((f) => f.description.includes('cluster-admin'))).toBe(true);
  });

  it('does not flag a scoped Role', () => {
    const content = `apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: pod-reader
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list"]
`;
    const findings = scanYamlInfraConfig('/repo/rbac.yaml', content);
    expect(findings).toHaveLength(0);
  });
});

describe('scanYamlInfraConfig - Docker Compose', () => {
  it('flags a privileged service, host network mode, and a mounted docker socket', () => {
    const content = `services:
  app:
    image: myrepo/app:1.2.3
    privileged: true
    network_mode: host
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
`;
    const findings = scanYamlInfraConfig('/repo/docker-compose.yml', content);
    expect(findings.some((f) => f.description.includes('privileged: true'))).toBe(true);
    expect(findings.some((f) => f.description.includes('network_mode: host'))).toBe(true);
    expect(findings.some((f) => f.description.includes('Docker socket'))).toBe(true);
  });

  it('does not flag an ordinary compose service', () => {
    const content = `services:
  app:
    image: myrepo/app:1.2.3
    ports:
      - "3000:3000"
`;
    const findings = scanYamlInfraConfig('/repo/docker-compose.yml', content);
    expect(findings).toHaveLength(0);
  });
});

describe('scanYamlInfraConfig - GitHub Actions', () => {
  it('flags untrusted event data interpolated into a run step', () => {
    const content = `on: [issues]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ github.event.issue.title }}"
`;
    const findings = scanYamlInfraConfig('/repo/.github/workflows/ci.yml', content);
    expect(findings.some((f) => f.category === 'ci-workflow-injection' && f.description.includes('shell command'))).toBe(true);
  });

  it('does not flag a run step with no untrusted interpolation', () => {
    const content = `on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`;
    const findings = scanYamlInfraConfig('/repo/.github/workflows/ci.yml', content);
    expect(findings).toHaveLength(0);
  });

  it('flags pull_request_target checking out the fork head ref', () => {
    const content = `on: pull_request_target
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.head.sha }}
`;
    const findings = scanYamlInfraConfig('/repo/.github/workflows/ci.yml', content);
    expect(findings.some((f) => f.description.includes('pull_request_target'))).toBe(true);
  });

  it('does not flag a normal checkout under pull_request_target', () => {
    const content = `on: pull_request_target
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`;
    const findings = scanYamlInfraConfig('/repo/.github/workflows/ci.yml', content);
    expect(findings).toHaveLength(0);
  });

  it('flags permissions: write-all', () => {
    const content = `on: push
permissions: write-all
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`;
    const findings = scanYamlInfraConfig('/repo/.github/workflows/ci.yml', content);
    expect(findings.some((f) => f.description.includes('write-all'))).toBe(true);
  });

  it('still detects the workflow when filePath uses Windows-style backslashes', () => {
    // Regression test: detectYamlFlavor's path check originally only matched
    // forward slashes, so this scan silently found nothing at all when run
    // via the CLI or a local dev build on Windows (filePath there is
    // backslash-separated) - only confirmed by running the real
    // analyzeRepo() pipeline end to end, not by the forward-slash-only unit
    // tests above.
    const content = `on: [issues]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ github.event.issue.title }}"
`;
    const findings = scanYamlInfraConfig('D:\\repo\\.github\\workflows\\ci.yml', content);
    expect(findings.some((f) => f.category === 'ci-workflow-injection')).toBe(true);
  });

  it('is not applied to a workflow-shaped file outside .github/workflows/', () => {
    const content = `on: [issues]
jobs:
  build:
    steps:
      - run: echo "\${{ github.event.issue.title }}"
`;
    const findings = scanYamlInfraConfig('/repo/some-other-dir/ci.yml', content);
    expect(findings).toHaveLength(0);
  });
});

describe('scanYamlInfraConfig - generic YAML', () => {
  it('does not flag plain YAML that is not k8s/compose/actions-shaped', () => {
    const content = `name: my-app
version: 1.0.0
settings:
  privileged: true
`;
    const findings = scanYamlInfraConfig('/repo/config.yaml', content);
    expect(findings).toHaveLength(0);
  });
});

describe('scanTerraformInfraConfig', () => {
  it('flags an ingress rule open to 0.0.0.0/0', () => {
    const content = `resource "aws_security_group" "web" {
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
`;
    const findings = scanTerraformInfraConfig('/repo/main.tf', content);
    expect(findings.some((f) => f.category === 'cloud-exposure' && f.description.includes('ingress'))).toBe(true);
  });

  it('does not flag an egress rule open to 0.0.0.0/0', () => {
    const content = `resource "aws_security_group" "web" {
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
`;
    const findings = scanTerraformInfraConfig('/repo/main.tf', content);
    expect(findings).toHaveLength(0);
  });

  it('flags a public-read S3 bucket ACL', () => {
    const content = `resource "aws_s3_bucket_acl" "assets" {
  bucket = aws_s3_bucket.assets.id
  acl    = "public-read"
}
`;
    const findings = scanTerraformInfraConfig('/repo/main.tf', content);
    expect(findings.some((f) => f.description.includes('publicly readable'))).toBe(true);
  });

  it('flags a publicly accessible database instance', () => {
    const content = `resource "aws_db_instance" "main" {
  identifier          = "main-db"
  publicly_accessible = true
}
`;
    const findings = scanTerraformInfraConfig('/repo/main.tf', content);
    expect(findings.some((f) => f.description.includes('reachable directly from the internet'))).toBe(true);
  });

  it('flags a wildcard IAM policy', () => {
    const content = `resource "aws_iam_policy" "admin" {
  name = "admin-policy"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "*"
      Resource = "*"
    }]
  })
}
`;
    const findings = scanTerraformInfraConfig('/repo/main.tf', content);
    expect(findings.some((f) => f.description.includes('unrestricted access to every AWS action'))).toBe(true);
  });

  it('does not flag a scoped IAM policy', () => {
    const content = `resource "aws_iam_policy" "reader" {
  name = "reader-policy"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject"]
      Resource = "arn:aws:s3:::my-bucket/*"
    }]
  })
}
`;
    const findings = scanTerraformInfraConfig('/repo/main.tf', content);
    expect(findings).toHaveLength(0);
  });
});

describe('scanDockerfileInfraConfig', () => {
  it('flags an unpinned base image', () => {
    const content = `FROM node:latest
COPY . .
RUN npm install
`;
    const findings = scanDockerfileInfraConfig('/repo/Dockerfile', content);
    expect(findings.some((f) => f.description.includes('unpinned tag'))).toBe(true);
  });

  it('does not flag a pinned base image', () => {
    const content = `FROM node:20.11.1-slim
COPY . .
RUN npm install
USER node
`;
    const findings = scanDockerfileInfraConfig('/repo/Dockerfile', content);
    expect(findings.filter((f) => f.description.includes('unpinned'))).toHaveLength(0);
  });

  it('does not treat a multi-stage FROM stage reference as an unpinned external image', () => {
    const content = `FROM node:20.11.1-slim AS builder
RUN npm run build

FROM builder
COPY --from=builder /app/dist ./dist
USER node
`;
    const findings = scanDockerfileInfraConfig('/repo/Dockerfile', content);
    expect(findings.filter((f) => f.description.includes('unpinned'))).toHaveLength(0);
  });

  it('flags a stage with no USER instruction', () => {
    const content = `FROM node:20.11.1-slim
COPY . .
RUN npm install
CMD ["node", "index.js"]
`;
    const findings = scanDockerfileInfraConfig('/repo/Dockerfile', content);
    expect(findings.some((f) => f.description.includes('no USER instruction'))).toBe(true);
  });

  it('does not flag a stage that sets USER', () => {
    const content = `FROM node:20.11.1-slim
COPY . .
RUN npm install
USER node
CMD ["node", "index.js"]
`;
    const findings = scanDockerfileInfraConfig('/repo/Dockerfile', content);
    expect(findings.filter((f) => f.description.includes('no USER instruction'))).toHaveLength(0);
  });

  it('flags ADD fetching a remote URL', () => {
    const content = `FROM node:20.11.1-slim
ADD https://example.com/install.sh /tmp/install.sh
RUN sh /tmp/install.sh
USER node
`;
    const findings = scanDockerfileInfraConfig('/repo/Dockerfile', content);
    expect(findings.some((f) => f.description.includes('ADD fetches a remote URL'))).toBe(true);
  });
});
