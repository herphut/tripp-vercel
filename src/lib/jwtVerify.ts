// lib/jwtVerify.ts
import crypto from "crypto";

type Jwk  = { kty: "RSA"; kid?: string; n?: string; e?: string; alg?: string; use?: string };
type Jwks = { keys: Jwk[] };

const JWKS_URL     = process.env.TRIPP_JWKS_URL!;
const EXPECTED_ISS = process.env.TRIPP_EXPECTED_ISS ?? "https://herphut.com";
const EXPECTED_AUD = process.env.TRIPP_EXPECTED_AUD ?? "tripp";
const CACHE_MIN    = Number(process.env.TRIPP_JWKS_CACHE_MIN || 5);
const TIMEOUT_MS   = Number(process.env.TRIPP_JWKS_TIMEOUT_MS || 3000);
const CLOCK_SKEW_S = Number(process.env.TRIPP_JWT_CLOCK_SKEW_S || 60);

if (!JWKS_URL)     throw new Error("env_missing: TRIPP_JWKS_URL");
if (!EXPECTED_ISS) throw new Error("env_missing: TRIPP_EXPECTED_ISS");
if (!EXPECTED_AUD) throw new Error("env_missing: TRIPP_EXPECTED_AUD");

let cached: { exp: number; jwks: Jwks } | null = null;

function b64urlToBuf(b64url: string) {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64");
}

async function fetchJWKS(): Promise<Jwks> {
  const now = Date.now();
  if (cached && cached.exp > now) return cached.jwks;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(JWKS_URL, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`jwks_http_${res.status}`);
    const jwks = (await res.json()) as Jwks;
    if (!jwks?.keys?.length) throw new Error("jwks_empty");
    cached = { exp: now + CACHE_MIN * 60_000, jwks };
    return jwks;
  } finally {
    clearTimeout(t);
  }
}

function rsaPublicKeyFromJwk(jwk: Jwk): crypto.KeyObject {
  if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) throw new Error("jwk_invalid");
  // @ts-ignore Node types may lag JWK import
  return crypto.createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
}

export async function verifyJwtRS256(idToken: string) {
  // Split token
  const [h, p, s] = idToken.split(".");
  if (!h || !p || !s) throw new Error("jwt_malformed");

  // Decode
  let header: any, payload: any;
  try {
    header  = JSON.parse(b64urlToBuf(h).toString("utf8"));
    payload = JSON.parse(b64urlToBuf(p).toString("utf8"));
  } catch {
    throw new Error("jwt_decode_failed");
  }
  const sig = b64urlToBuf(s);

  // Header sanity
  if (header.alg !== "RS256") throw new Error("alg_mismatch");
  if (header.typ && header.typ !== "JWT") throw new Error("typ_mismatch");
  const kid = header.kid;
  if (!kid) throw new Error("kid_missing");

  // Load key by kid
  const jwks = await fetchJWKS();
  const jwk  = jwks.keys.find(k => k.kid === kid && (k.alg ?? "RS256") === "RS256");
  if (!jwk) throw new Error("kid_not_found");

  // Verify RS256 signature
  const verify = crypto.createVerify("RSA-SHA256");
  verify.update(`${h}.${p}`);
  verify.end();
  const pubKey = rsaPublicKeyFromJwk(jwk);
  let ok = verify.verify(pubKey, sig);

  if (!ok) {
    // One-time JWKS refresh (in case of rotation)
    cached = null;
    const jwks2 = await fetchJWKS();
    const jwk2  = jwks2.keys.find(k => k.kid === kid && (k.alg ?? "RS256") === "RS256");
    if (!jwk2) throw new Error("kid_not_found_after_refresh");
    const pubKey2 = rsaPublicKeyFromJwk(jwk2);
    const v2 = crypto.createVerify("RSA-SHA256");
    v2.update(`${h}.${p}`);
    v2.end();
    ok = v2.verify(pubKey2, sig);
    if (!ok) throw new Error("sig_fail");
  }

  // Claims checks
  const now = Math.floor(Date.now() / 1000);

  if (payload.iss !== EXPECTED_ISS) {
    throw new Error(`iss:${payload.iss}`);
  }

  // ✅ FIX: normalize aud then compare
  const tokenAud: string =
    Array.isArray(payload.aud) ? (payload.aud[0] ?? "") : (payload.aud ?? "");
  if (tokenAud !== EXPECTED_AUD) {
    throw new Error(`aud:${JSON.stringify(payload.aud)}`);
  }

  if (typeof payload.nbf === "number" && payload.nbf > now + CLOCK_SKEW_S) {
    throw new Error(`nbf:${payload.nbf}`);
  }
  if (typeof payload.exp === "number" && now - CLOCK_SKEW_S > payload.exp) {
    throw new Error(`exp:${payload.exp}`);
  }
  if (typeof payload.iat === "number" && payload.iat > now + CLOCK_SKEW_S) {
    throw new Error(`iat:${payload.iat}`);
  }

  return { header, payload };
}
