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
  setApiKeyRateTier,
  setLegacyQueryKey,
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
  endImpersonationAsSuperAdmin,
  getMemberAccess,
  getStaffMe,
  isImpersonatorCurrent,
  listAgencyMembers,
  listLiveImpersonations,
  listStaffAccess,
  startImpersonation,
  userNames,
} from './impersonation';
export { identityJobs } from './jobs';
export { getMe, type SessionClaims } from './me';
export { can } from './policy';
export {
  acceptInvite,
  changeMemberRole,
  deactivateMember,
  inviteMember,
  isActiveMember,
  isSessionValid,
  issueAccessToken,
  listInvites,
  listMembers,
  memberNames,
  register,
  requestPasswordReset,
  resetPassword,
  revokeInvite,
  verifyCredentials,
  verifyEmail,
} from './service';
export {
  activeClientMemberIds,
  activeClientMembersAmong,
  getStaffRole,
  grantStaff,
  isUserActive,
  listAgencyAdmins,
  memberRecipient,
  revokeStaff,
  STAFF_ROLES,
  type StaffRole,
  teamContacts,
} from './staff';
export { registerIdentitySubscriptions, unregisterIdentitySubscriptions } from './subscriptions';
export {
  checkMfaProof,
  confirmEnrolment,
  disableTwoFactor,
  forgetRememberedBrowsers,
  getPendingEnrolment,
  getTwoFactorStatus,
  regenerateRecoveryCodes,
  startEnrolment,
  verifySecondFactor,
  verifyStepUp,
} from './two-factor';
