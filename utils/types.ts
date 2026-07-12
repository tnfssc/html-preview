export interface RepoRef {
  owner: string;
  repo: string;
  ref: string;
  path: string;
}

export type DiagnosticLevel = 'warning' | 'error';

export interface ResolveDiagnostic {
  level: DiagnosticLevel;
  code: string;
  message: string;
  url?: string;
}

export interface ResourceStats {
  fetched: number;
  inlined: number;
  rewritten: number;
  skipped: number;
  failed: number;
  bytes: number;
  maxDepthReached: number;
}

export interface ResolveResult {
  html: string;
  diagnostics: ResolveDiagnostic[];
  resources: ResourceStats;
}

export interface ResolveLimits {
  maxResourceBytes: number;
  maxTotalBytes: number;
  maxDepth: number;
  concurrency: number;
}

export interface ResolveOptions {
  target: 'static' | 'sandbox' | 'sandbox-private';
  repoRef: RepoRef;
  githubToken?: string | null;
  privateRepo?: boolean;
  signal?: AbortSignal;
  limits?: Partial<ResolveLimits>;
}
