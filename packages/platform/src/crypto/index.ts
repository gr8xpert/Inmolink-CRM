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
  type HmacPurpose,
  hmacSha256,
  hmacSha256Hex,
  newToken,
  safeEqual,
  verifyHmacSha256,
  verifyRawHmacSha256Hex,
} from './hmac';
