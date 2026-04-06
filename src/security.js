import { createHash, timingSafeEqual } from "node:crypto";

function digest(value) {
  return createHash("sha256").update(String(value)).digest();
}

export function safeEqual(left, right) {
  return timingSafeEqual(digest(left), digest(right));
}

export function verifyAdminCredentials(credentials, authConfig) {
  if (!authConfig?.enabled) {
    return true;
  }

  if (!credentials) {
    return false;
  }

  const usernameOk = safeEqual(credentials.username, authConfig.username);
  const passwordOk = safeEqual(credentials.password, authConfig.password || "");

  return usernameOk && passwordOk;
}
