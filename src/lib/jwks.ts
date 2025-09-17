// lib/jwks.ts
import { createRemoteJWKSet, jwtVerify } from "jose";

const JWKS = createRemoteJWKSet(
  new URL("https://herphut.com/wp-json/herphut-sso/v1/jwks")
);

export async function verifyWPToken(token: string) {
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: "https://herphut.com",          // must match WP get_site_url()
    audience: "https://tripp.herphut.com",  // must match plugin 'aud'
  });
  return payload;
}
