/** @inmolink/sdk — typed client for website API v2 (S7-03) and, later, the JS widget (S8-06). */
export const PACKAGE_NAME = '@inmolink/sdk';
export {
  createWebsiteClient,
  edgeKeyToken,
  WebsiteApiError,
  type WebsiteClient,
  type WebsiteClientOptions,
} from './client';
export * from './website-v2.generated';
