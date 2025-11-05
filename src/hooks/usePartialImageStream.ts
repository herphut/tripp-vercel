// src/hooks/usePartialImageStream.ts
import { useEffect, useRef, useState } from "react";

type Options = {
  size?: "1024x1024" | "1024x1536" | "1536x1024";
  partials?: number; // 1-3
};

export function usePartialImageStream(prompt: string, opts: Options = {}) {
  const { size = "1024x1024", partials = 2 } = opts;
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "streaming" | "done" | "error">("idle");
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!prompt) return;
    setImgSrc(null);
    setStatus("streaming");

    const params = new URLSearchParams({ prompt, size, partials: String(partials) });
    const url = `/api/image/stream?${params.toString()}`;

    const es = new EventSource(url);
    esRef.current = es;

    // Most browsers support named events via addEventListener.
    // We listen for partial frames and the final image. We also provide a
    // generic onmessage fallback in case the SDK bundles as default events.

    const onPartial = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data);
        const b64 = data?.partial_image_b64 || data?.partial_image || data?.base64;
        if (typeof b64 === "string" && b64.length > 100) {
          setImgSrc(`data:image/png;base64,${b64}`);
        }
      } catch {
        // ignore bad frames
      }
    };

    const onFinal = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data);
        // Some SDKs emit final images differently; check a few common fields:
        const finalB64 =
          data?.image_base64 ||
          data?.b64_json ||
          data?.image_b64 ||
          data?.result ||
          null;
        if (typeof finalB64 === "string" && finalB64.length > 100) {
          setImgSrc(`data:image/png;base64,${finalB64}`);
        }
        setStatus("done");
        es.close();
      } catch {
        setStatus("error");
        es.close();
      }
    };

    const onDefault = (ev: MessageEvent) => {
      // Fallback path: parse each message and switch on `type`.
      try {
        const payload = JSON.parse(ev.data);
        const type = payload?.type as string;

        if (type === "response.image_generation_call.partial_image") {
          const b64 = payload?.partial_image_b64;
          if (typeof b64 === "string" && b64.length > 100) {
            setImgSrc(`data:image/png;base64,${b64}`);
          }
        }
        if (type === "response.completed" || type === "response.image_output") {
          // Many SDKs emit the completed image as a final chunk; handle common fields
          const finalB64 =
            payload?.image_base64 ||
            payload?.b64_json ||
            payload?.image_b64 ||
            payload?.result ||
            null;
          if (typeof finalB64 === "string" && finalB64.length > 100) {
            setImgSrc(`data:image/png;base64,${finalB64}`);
          }
          setStatus("done");
          es.close();
        }
      } catch {
        // ignore
      }
    };

    // Named event listeners (best)
    es.addEventListener("response.image_generation_call.partial_image", onPartial as any);
    es.addEventListener("response.completed", onFinal as any);

    // Fallback for default events
    es.onmessage = onDefault;
    es.onerror = () => {
      setStatus("error");
      es.close();
    };

    return () => {
      es.removeEventListener("response.image_generation_call.partial_image", onPartial as any);
      es.removeEventListener("response.completed", onFinal as any);
      es.close();
    };
  }, [prompt, size, partials]);

  return { imgSrc, status };
}
