import { afterEach, describe, expect, it } from "vitest";
import { DEADLINE_DEFAULTS, deadlines, loadDeadlines, resetDeadlinesForTest, saveDeadlines } from "@/modules/settings/deadlines";
import { renewalPingDate } from "@/modules/health/service";
import { actorFor, ensureSeed } from "./helpers";

describe("e72 einstellbare Fristen", () => {
  afterEach(async () => {
    await ensureSeed();
    await saveDeadlines(await actorFor("clemens"), { ...DEADLINE_DEFAULTS });
    resetDeadlinesForTest();
  });

  it("Standardwerte gelten ohne Einstellung; die Verlängerungsfrist wirkt auf den Ping-Termin", async () => {
    resetDeadlinesForTest();
    expect(renewalPingDate({ plannedEnd: "2027-06-30", renewalDeadline: null })).toBe("2027-04-01");
    resetDeadlinesForTest({ renewalLeadDays: 60 });
    expect(renewalPingDate({ plannedEnd: "2027-06-30", renewalDeadline: null })).toBe("2027-05-01");
  });

  it("GF speichert, Werte werden geladen; BD darf nicht, unplausible Werte werden abgelehnt", async () => {
    await ensureSeed();
    const gf = await actorFor("clemens");
    await saveDeadlines(gf, { renewalLeadDays: "75", checkinDays: "30", offerFollowUpDays: "7", offerExpiryDays: "45" });
    resetDeadlinesForTest();
    expect(await loadDeadlines(true)).toEqual({ renewalLeadDays: 75, checkinDays: 30, offerFollowUpDays: 7, offerExpiryDays: 45 });
    expect(deadlines().checkinDays).toBe(30);
    await expect(saveDeadlines(await actorFor("david"), { ...DEADLINE_DEFAULTS })).rejects.toThrow(/Geschäftsführung/);
    await expect(saveDeadlines(gf, { ...DEADLINE_DEFAULTS, checkinDays: "3" })).rejects.toThrow(/zwischen 14 und 120/);
    await expect(saveDeadlines(gf, { ...DEADLINE_DEFAULTS, offerFollowUpDays: "30", offerExpiryDays: "20" })).rejects.toThrow(/länger/);
  });
});
