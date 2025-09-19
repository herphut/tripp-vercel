// lib/jwtVerify.ts
import crypto from "crypto";

type Jwk = { kty: string; kid?: string; n?: string; e?: string; alg?: string; use?: string };
type Jwks = { keys: Jwk[] };

const JWKS_URL = process.env.TRIPP_JWKS_URL!;
const EXPECTED_ISS = process.env.TRIPP_EXPECTED_ISS!;
const EXPECTED_AUD = process.env.TRIPP_EXPECTED_AUD!;
const CACHE_MIN = Number(process.env.TRIPP_JWKS_CACHE_MIN || 5);
const TIMEOUT_MS = Number(process.env.TRIPP_JWKS_TIMEOUT_MS || 3000);

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
    const res = await fetch(JWKS_URL, { signal: ctrl.signal, headers: { "Accept": "application/json" } });
    if (!res.ok) throw new Error(`jwks_fetch_${res.status}`);
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
  const pub = {
    kty: "RSA",
    n: jwk.n,
    e: jwk.e,
  };
  // Build an SPKI PEM from JWK
  const der = crypto.createPublicKey({
    key: Buffer.from(
      require("jose").exportJWK ? "" : "" // placeholder if using jose; but we avoid extra deps
    ),
  });

  // Simpler: use Node crypto with JWK import (Node 20+ supports format:'jwk')
  // @ts-ignore
  return crypto.createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
}

export async function verifyJwtRS256(idToken: string) {
  // Parse segments
  const [h, p, s] = idToken.split(".");
  if (!h || !p || !s) throw new Error("jwt_malformed");

  const header = JSON.parse(Buffer.from(b64urlToBuf(h)).toString("utf8"));
  const payload = JSON.parse(Buffer.from(b64urlToBuf(p)).toString("utf8"));
  const sig = b64urlToBuf(s);

  if (header.alg !== "RS256") throw new Error("alg_mismatch");
  const kid = header.kid;
  if (!kid) throw new Error("kid_missing");

  // Load JWKS + pick key
  const jwks = await fetchJWKS();
  const jwk = jwks.keys.find(k => k.kid === kid && (k.alg ?? "RS256") === "RS256");
  if (!jwk) throw new Error("kid_not_found");

  // Verify signature
  const verify = crypto.createVerify("RSA-SHA256");
  verify.update(`${h}.${p}`);
  verify.end();
  const pubKey = rsaPublicKeyFromJwk(jwk);
  const ok = verify.verify(pubKey, sig);
  if (!ok) {
    // Force-refresh JWKS once in case of rotation, then retry once
    cached = null;
    const jwks2 = await fetchJWKS();
    const jwk2 = jwks2.keys.find(k => k.kid === kid && (k.alg ?? "RS256") === "RS256");
    if (!jwk2) throw new Error("kid_not_found_2");
    const pubKey2 = rsaPublicKeyFromJwk(jwk2);
    const verify2 = crypto.createVerify("RSA-SHA256");
    verify2.update(`${h}.${p}`);
    verify2.end();
    if (!verify2.verify(pubKey2, sig)) throw new Error("sig_fail");
  }

  // Claims checks
  const now = Math.floor(Date.now() / 1000);
  const skew = 120;
  if (payload.iss !== EXPECTED_ISS) throw new Error("iss");
  if (payload.aud !== EXPECTED_AUD) throw new Error("aud");
  if (typeof payload.nbf === "number" && payload.nbf > now + skew) throw new Error("nbf");
  if (typeof payload.exp === "number" && now - skew > payload.exp) throw new Error("exp");

  return { header, payload }; // includes sub/email/tier/etc.
}
