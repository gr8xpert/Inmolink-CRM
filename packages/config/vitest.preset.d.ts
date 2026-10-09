import type { UserWorkspaceConfig } from 'vitest/config';

export declare function inmolinkProject(options?: {
  environment?: 'node' | 'jsdom' | 'happy-dom';
}): UserWorkspaceConfig;
