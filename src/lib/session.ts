export type MemoryOptIn = boolean;

function readBoolShape(j: any): MemoryOptIn | null {
  if (j && typeof j === "object") {
    if ("memory_opt_in" in j) return !!j.memory_opt_in;  // new route
    if ("memoryOptIn" in j)   return !!j.memoryOptIn;     // old shape (tolerate)
    if (j.data && typeof j.data === "object") {
      if ("memory_opt_in" in j.data) return !!j.data.memory_opt_in;
      if ("memoryOptIn"   in j.data) return !!j.data.memoryOptIn;
    }
  }
  return null;
}

export async function getMemoryPref(): Promise<MemoryOptIn> {
  const r = await fetch("/api/prefs", {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });

  // unauthenticated → off
  if (r.status === 401) return false;

  if (!r.ok) {
    console.debug("[getMemoryPref] /api/prefs failed:", r.status);
    return false;
  }
  const j = await r.json();
  const v = readBoolShape(j);
  return v ?? false;
}
