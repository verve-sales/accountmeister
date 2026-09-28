"use client";

import { useState } from "react";

/**
 * Felder für „Rolle zuweisen" (Verwaltung): bei Rolle BD ist die Kundenauswahl zwingend – „arbeitsraumweit“ ist für
 * BD kein wählbarer Zustand mehr (verhindert das versehentliche Anlegen einer arbeitsraumweiten BD-Rolle, die dann
 * alle Kunden sichtbar macht). Für andere Rollen (z. B. Principal) bleibt „arbeitsraumweit“ weiterhin möglich –
 * serverseitig zusätzlich abgesichert in modules/governance/service.ts (assignRole).
 */
export function RoleAssignFields({
  users,
  roleLabelEntries,
  accounts,
}: {
  users: { id: string; displayName: string }[];
  roleLabelEntries: [string, string][];
  accounts: { id: string; name: string }[];
}) {
  const [role, setRole] = useState<string>(roleLabelEntries[0]?.[0] ?? "");
  const accountRequired = role === "BD";
  return (
    <>
      <div>
        <label className="label" htmlFor="rUser">Person</label>
        <select id="rUser" name="userId" className="select">
          {users.map((u) => (
            <option key={u.id} value={u.id}>{u.displayName}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="rRole">Rolle</label>
        <select id="rRole" name="role" className="select" value={role} onChange={(e) => setRole(e.target.value)}>
          {roleLabelEntries.map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="rAccount">
          Kunde {accountRequired ? "(bei BD zwingend – arbeitsraumweit ist für BD nicht vorgesehen)" : "(nur BD/Principal kundenbezogen)"}
        </label>
        <select id="rAccount" name="accountId" className="select" required={accountRequired} defaultValue="">
          {!accountRequired && <option value="">– arbeitsraumweit –</option>}
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      </div>
    </>
  );
}
