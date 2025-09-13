import crypto from "crypto";

export function newSessionId() {
  return crypto.randomBytes(16).toString("hex"); // 32 chars
}

export function hashIP(ip: string) {
  return crypto.createHash("sha256").update(ip).digest("hex").slice(0, 64);
}

export function today() {
  return new Date().toISOString().slice(0,10); // YYYY-MM-DD
}
