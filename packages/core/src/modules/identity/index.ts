/** identity — login identity, sign-up with agency-of-one, memberships, team and invites, staff, 2FA, API keys (S0-09, S1-01…S1-05). */
export {
  API_KEY_AGENCY_RULE,
  API_KEY_FAILURE_RULE,
  API_KEY_REHASH_SET,
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
// S12-06: Client Mode — enter (tenant ctx), the session callback's proof check and the exit PIN (app_auth).
export {
  activateClientMode,
  activeClientModeOf,
  CLIENT_MODE_ATTEMPTS_WINDOW_SECONDS,
  CLIENT_MODE_PIN_LIMITS,
  CLIENT_MODE_PROOF_TTL_MS,
  CLIENT_MODE_TTL_SECONDS,
  type ClientModePinResult,
  type ClientModeState,
  checkClientModePin,
  clientModeAtLogin,
  isClientModeState,
  openClientModeProof,
  startClientMode,
} from './client-mode';
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
export { CLIENT_MODE_ALLOWED, can } from './policy';
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
export { activeMembersAcross, disconnectDeactivatedMember, disconnectRevokedSessions } from './sessions';
export {
  activeClientMemberIds,
  activeClientMembersAcross,
  activeClientMembersAmong,
  agencyAdminsOf,
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
