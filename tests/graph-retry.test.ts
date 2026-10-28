import { describe, expect, it } from "vitest";
import { graphGet } from "@/modules/integrations/graph/client";
import { AdapterError } from "@/modules/integrations/adapter";

const resp = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

describe("Etappe 41: Microsoft Graph – vorübergehende Fehler automatisch wiederholen", () => {
  it("G01: 503 → zweiter Versuch gelingt; Retry-After wird beachtet (gedeckelt)", async () => {
    const calls: number[] = [];
    const waits: number[] = [];
    const answers = [resp(503, {}, { "Retry-After": "30" }), resp(200, { value: [1] })];
    const fetchImpl = (async () => { calls.push(1); return answers.shift()!; }) as unknown as typeof fetch;
    const r = await graphGet("/me/messages", "t", fetchImpl, async (ms) => { waits.push(ms); });
    expect(r).toEqual({ value: [1] });
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([8000]);
  });

  it("G02: dreimal 503 → verständliche Meldung; 403 wird nicht wiederholt", async () => {
    let n = 0;
    const always503 = (async () => { n++; return resp(503); }) as unknown as typeof fetch;
    const err = await graphGet("/me/messages", "t", always503, async () => {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as Error).message).toMatch(/nicht am Accountmeister/);
    expect(n).toBe(3);
    let m = 0;
    const forbidden = (async () => { m++; return resp(403); }) as unknown as typeof fetch;
    await expect(graphGet("/me/chats", "t", forbidden, async () => {})).rejects.toBeInstanceOf(AdapterError);
    expect(m).toBe(1);
  });

  it("G03: Netzfehler/Zeitüberschreitung → erneuter Versuch", async () => {
    let k = 0;
    const flaky = (async () => { k++; if (k === 1) throw new Error("timeout"); return resp(200, { ok: true }); }) as unknown as typeof fetch;
    expect(await graphGet("/me", "t", flaky, async () => {})).toEqual({ ok: true });
  });
});
