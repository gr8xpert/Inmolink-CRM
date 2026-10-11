/** identity — login identity, sign-up with agency-of-one, memberships, team and invites, staff, 2FA (S0-09, S1-01…S1-04). */
export { configureIdentity, type IdentityConfig, TOKEN_TTL_MS, TWO_FACTOR } from './config';
export { identityErrors } from './errors';
export { identityEvents } from './events';
export { identityJobs } from './jobs';
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
