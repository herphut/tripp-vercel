export type ClientType = "public_browser" | "server" | "admin";

export const CLIENTS: Record<string, {
  type: ClientType;
  scopes: string[];
  limits: { rpm?: number; dailyMsgs?: number };
}> = {
  "web-widget-v1": { type: "public_browser", scopes: ["chat:*"], limits: { rpm: 20, dailyMsgs: 300 } },
  "wp-herphut":    { type: "server",         scopes: ["chat:*","forums:*","memory:*"], limits: { rpm: 60 } },
  "admin-console": { type: "admin",          scopes: ["admin:*","chat:*"], limits: {} },
};
