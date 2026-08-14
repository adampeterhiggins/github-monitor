/** Shapes returned by the GitHub REST endpoints this app consumes. */

export interface GhRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  disabled: boolean;
  default_branch: string;
  language: string | null;
  size: number;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  watchers_count: number;
  created_at: string;
  updated_at: string;
  pushed_at: string | null;
  html_url: string;
  description: string | null;
  topics?: string[];
  permissions?: { admin: boolean; push: boolean; pull: boolean; maintain?: boolean };
}

export interface GhAuthor {
  login: string;
  id: number;
  avatar_url: string;
  html_url: string;
  type: string;
}

/** One week bucket in the contributor stats payload. `w` is a Unix week start (Sunday, UTC). */
export interface GhStatsWeek {
  w: number;
  /** Additions. */
  a: number;
  /** Deletions. */
  d: number;
  /** Commits. */
  c: number;
}

export interface GhContributorStats {
  author: GhAuthor | null;
  total: number;
  weeks: GhStatsWeek[];
}

/** `stats/commit_activity`: 52 weeks, `days` indexed Sunday..Saturday. */
export interface GhCommitActivity {
  days: number[];
  total: number;
  week: number;
}

/** `stats/participation`: 52 weeks of counts, oldest first. */
export interface GhParticipation {
  all: number[];
  owner: number[];
}

/** `stats/code_frequency`: [weekUnix, additions, deletions] with deletions negative. */
export type GhCodeFrequency = [number, number, number];

/** `stats/punch_card`: [dayOfWeek 0=Sunday, hour 0-23, commits]. */
export type GhPunchCard = [number, number, number];

export interface GhTrafficCount {
  timestamp: string;
  count: number;
  uniques: number;
}

export interface GhTrafficViews {
  count: number;
  uniques: number;
  views: GhTrafficCount[];
}

export interface GhTrafficClones {
  count: number;
  uniques: number;
  clones: GhTrafficCount[];
}

export interface GhTrafficPath {
  path: string;
  title: string;
  count: number;
  uniques: number;
}

export interface GhTrafficReferrer {
  referrer: string;
  count: number;
  uniques: number;
}

export interface GhCommunityProfile {
  health_percentage: number;
  description: string | null;
  documentation: string | null;
  files: Record<string, { url: string; html_url: string } | null>;
  updated_at: string | null;
  content_reports_enabled?: boolean;
}

export interface GhWorkflowRun {
  id: number;
  name: string | null;
  head_branch: string | null;
  event: string;
  status: string | null;
  conclusion: string | null;
  workflow_id: number;
  created_at: string;
  updated_at: string;
  run_started_at?: string;
  run_attempt?: number;
}

export interface GhWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
}

export interface GhDependabotAlert {
  number: number;
  state: string;
  dependency: { package: { ecosystem: string; name: string }; manifest_path?: string };
  security_advisory: { ghsa_id: string; severity: string; summary: string };
  created_at: string;
  dismissed_at: string | null;
  fixed_at: string | null;
  /** Present on the org-level alerts endpoint; absent on the per-repo one. */
  repository?: { id: number; name: string; full_name: string } | null;
}

export interface GhSbomPackage {
  SPDXID: string;
  name: string;
  versionInfo?: string;
  externalRefs?: Array<{ referenceCategory: string; referenceLocator: string; referenceType: string }>;
}

export interface GhSbomResponse {
  sbom: {
    SPDXID: string;
    name: string;
    packages: GhSbomPackage[];
  };
}

export interface GhFork {
  id: number;
  full_name: string;
  owner: GhAuthor;
  html_url: string;
  created_at: string;
  pushed_at: string | null;
  stargazers_count: number;
}

export interface GhBranch {
  name: string;
  commit: { sha: string };
  protected: boolean;
}
