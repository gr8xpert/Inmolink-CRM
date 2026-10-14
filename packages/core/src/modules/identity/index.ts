/** identity — login identity, sign-up with agency-of-one, memberships, team and invites, staff, 2FA, API keys (S0-09, S1-01…S1-05). */
export {
  API_KEY_AGENCY_RULE,
  API_KEY_FAILURE_RULE,
  API_KEY_USAGE_SET,
  type ApiKeyPrincipal,
  type ApiKeyRequest,
  apiKeyRateRule,
  authenticateApiKey,
  createApiKey,
  listApiKeys,
  resetApiKeyUsageMarks,
  revokeApiKey,
  rotateApiKey,
} from './api-keys';
export {
  API_KEYS,
  type ApiKeyEnv,
  apiKeyEnvFor,
  configureIdentity,
  type IdentityConfig,
  TOKEN_TTL_MS,
  TWO_FACTOR,
} from './config';
export { identityErrors } from './errors';
export { identityEvents } from './events';
export {
  endImpersonation,
  getStaffMe,
  isImpersonationLive,
  isImpersonatorActive,
  listAgencyMembers,
  startImpersonation,
} from './impersonation';
export { identityJobs } from './jobs';
export { getMe, type SessionClaims } from './me';
export { can } from './policy';
export {
  acceptInvite,
  changeMemberRole,
  deactivateMember,
  getMemberRole,
  inviteMember,
  isSessionValid,
  issueAccessToken,
  listInvites,
  listMembers,
  register,
  requestPasswordReset,
  resetPassword,
  revokeInvite,
  verifyCredentials,
  verifyEmail,
} from './service';
export {
  getStaffRole,
  grantStaff,
  isUserActive,
  listAgencyAdmins,
  revokeStaff,
  STAFF_ROLES,
  type StaffRole,
} from './staff';
export { registerIdentitySubscriptions, unregisterIdentitySubscriptions } from './subscriptions';
export {
  checkMfaProof,
  confirmEnrolment,
  disableTwoFactor,
  getTwoFactorStatus,
  regenerateRecoveryCodes,
  startEnrolment,
  verifySecondFactor,
} from './two-factor';
