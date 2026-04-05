import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const SCRYPT_KEYLEN = 64;

function digest(value) {
  return createHash("sha256").update(String(value)).digest();
}

export function safeEqual(left, right) {
  return timingSafeEqual(digest(left), digest(right));
}

export function createPasswordHash(password) {
  const value = String(password || "");

  if (!value) {
    throw new Error("Password is required.");
  }

  const salt = randomBytes(16);
  const hash = scryptSync(value, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPasswordHash(password, encodedHash) {
  const value = String(encodedHash || "").trim();
  const parts = value.split("$");

  if (parts.length !== 3 || parts[0] !== "scrypt") {
    throw new Error("Unsupported password hash format.");
  }

  const salt = Buffer.from(parts[1], "base64url");
  const expected = Buffer.from(parts[2], "base64url");
  const actual = scryptSync(String(password || ""), salt, expected.length);
  return timingSafeEqual(actual, expected);
}

export function verifyAdminCredentials(credentials, authConfig) {
  if (!authConfig?.enabled) {
    return true;
  }

  if (!credentials) {
    return false;
  }

  const usernameOk = safeEqual(credentials.username, authConfig.username);

  if (!usernameOk) {
    return false;
  }

  if (authConfig.passwordHash) {
    return verifyPasswordHash(credentials.password, authConfig.passwordHash);
  }

  return safeEqual(credentials.password, authConfig.password || "");
}
