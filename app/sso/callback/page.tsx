'use client';
import { useEffect } from "react";

export default function SSOCallback() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const token = params.get("token");
    if (token) {
      fetch("/api/auth/wp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      }).then(() => window.location.replace("/"));
    } else {
      window.location.replace("/login"); // or home
    }
  }, []);
  return <p>Signing you in… 🦎</p>;
}
