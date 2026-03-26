import crypto from "node:crypto";

/**
 * Replicate the router's PBKDF2 hashing:
 * sjcl.misc.pbkdf2(password, salt, 1000, 128) → hex encoded
 *
 * sjcl uses HMAC-SHA256 by default, 1000 iterations, 128 bits (16 bytes) output.
 * The salt is passed as a string directly (sjcl accepts string salts).
 */
export function pbkdf2(password, salt) {
  const key = crypto.pbkdf2Sync(password, salt, 1000, 16, "sha256");
  return key.toString("hex");
}
