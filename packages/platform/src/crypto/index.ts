/**
 * AES-256-GCM keyring and HMAC. Password hashing is a separate subpath
 * (`@inmolink/platform/crypto/password`) so only identity loads the native Argon2 binary.
 */
export {
  type AadParts,
  aadFor,
  createKeyring,
  DecryptError,
  generateKey,
  type Keyring,
  type KeyringInput,
  keyringFromEnv,
  parseKeyList,
} from './aead';
export {
  configureHmacRotation,
  type HmacPurpose,
  type HmacRotationInput,
  hmacKeyCandidates,
  hmacKeyLabel,
  hmacRotationEndsAt,
  hmacRotationFromEnv,
  hmacSha256,
  hmacSha256Candidates,
  hmacSha256Hex,
  newToken,
  safeEqual,
  verifyHmacSha256,
  verifyHmacSha256Rotating,
  verifyRawHmacSha256Hex,
} from './hmac';
export { type RowCipher, rowCipher } from './row-cipher';
export {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  matchTotp,
  TOTP_DIGITS,
  TOTP_STEP_SECONDS,
  totpCode,
  totpStep,
  totpUri,
} from './totp';
