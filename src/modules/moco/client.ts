import { readFile } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "@/lib/config";

/**
 * Moco-Anbindung (Etappe 31): schmaler, lesender Client auf die Moco-REST-API v1.
 * Quelle: https://everii-group.github.io/mocoapp-api-docs/ (Authentifizierung `Authorization: Token token=…`,
 * Pagination über `page`/`per_page` und Kopfzeile `X-Total`, Limit 120 Anfragen je 2 Minuten im Standardplan).
 *
 * Es werden nur die Felder abgebildet, die der Accountmeister braucht. Personenbezogene Felder wie IBAN,
 * Privatadresse oder Geburtstag werden bewusst nicht übernommen (Whitelist in `pickUser`).
 */

export type MocoUser = {
  id: number;
  firstname: string;
  lastname: string;
  email: string | null;
  active: boolean;
  external: boolean;
  unit: { id: number; name: string } | null;
  role: { id: number; name: string } | null;
  updated_at?: string;
};

export type MocoCompany = {
  id: number;
  type: "customer" | "supplier" | "organization";
  name: string;
  identifier: string | null;
  active?: boolean;
  updated_at?: string;
};

export type MocoProjectGroup = {
  id: number;
  name: string;
  company: { id: number; name: string } | null;
  user: { id: number; firstname: string; lastname: string } | null;
  projects?: { id: number; name: string }[];
};

export type MocoContract = {
  id: number;
  user_id: number;
  firstname: string;
  lastname: string;
  billable: boolean;
  active: boolean;
  budget: number | null;
  hourly_rate: number | null;
};

export type MocoProject = {
  id: number;
  identifier: string | null;
  name: string;
  active: boolean;
  billable: boolean;
  start_date: string | null;
  finish_date: string | null;
  hourly_rate: number | null;
  currency: string | null;
  customer: { id: number; name: string } | null;
  leader: { id: number; firstname: string; lastname: string } | null;
  project_group: { id: number; name: string } | null;
  deal: { id: number; name: string } | null;
  tags: string[];
  contracts: MocoContract[];
  updated_at?: string;
};

/** Lead-Phase in Moco (Akquise → Phasen), mit Wahrscheinlichkeit in Prozent. */
export type MocoDealCategory = { id: number; name: string; probability: number };

export type MocoDeal = {
  id: number;
  name: string;
  status: "potential" | "pending" | "won" | "lost" | "dropped";
  money: number;
  currency: string;
  reminder_date: string | null;
  company: { id: number; name: string } | null;
  user: { id: number; firstname: string; lastname: string } | null;
  category: { id: number; name: string } | null;
  info: string | null;
  tags: string[];
};

/** Felder, die der Accountmeister beim Anlegen eines Leads an Moco schickt (POST /deals). */
export type MocoDealCreate = {
  name: string;
  currency: string;
  money: number;
  reminder_date: string;
  user_id: number;
  deal_category_id: number;
  company_id?: number;
  info?: string;
  status?: MocoDeal["status"];
  tags?: string[];
};

export interface MocoClient {
  readonly kind: "http" | "fixture";
  users(opts?: { includeArchived?: boolean }): Promise<MocoUser[]>;
  companies(opts?: { type?: "customer" | "supplier" | "organization" }): Promise<MocoCompany[]>;
  projectGroups(): Promise<MocoProjectGroup[]>;
  projects(opts?: { includeArchived?: boolean; updatedFrom?: string }): Promise<MocoProject[]>;
  project(id: number): Promise<MocoProject | null>;
  /** Lead-Phasen (Akquise-Pipeline) */
  dealCategories(): Promise<MocoDealCategory[]>;
  /** Alle Leads (zur Dublettenprüfung vor dem Push) */
  deals(): Promise<MocoDeal[]>;
  /** Einziger schreibender Aufruf: Lead anlegen (Etappe 32, Lead-Push AM → Moco). */
  createDeal(payload: MocoDealCreate): Promise<MocoDeal>;
}

export class MocoConfigError extends Error {}

/** Whitelist der Nutzerfelder – alles andere (IBAN, Adresse, Geburtstag …) wird verworfen. */
export function pickUser(raw: Record<string, unknown>): MocoUser {
  const unit = raw.unit as { id: number; name: string } | null | undefined;
  const role = raw.role as { id: number; name: string } | null | undefined;
  return {
    id: Number(raw.id),
    firstname: String(raw.firstname ?? ""),
    lastname: String(raw.lastname ?? ""),
    email: raw.email ? String(raw.email).toLowerCase() : null,
    active: raw.active !== false,
    external: raw.external === true || raw.extern === true,
    unit: unit ? { id: Number(unit.id), name: String(unit.name) } : null,
    role: role ? { id: Number(role.id), name: String(role.name) } : null,
    updated_at: raw.updated_at ? String(raw.updated_at) : undefined,
  };
}

export function pickProject(raw: Record<string, unknown>): MocoProject {
  const rel = (k: string) => (raw[k] && typeof raw[k] === "object" ? (raw[k] as Record<string, unknown>) : null);
  const customer = rel("customer");
  const leader = rel("leader");
  const group = rel("project_group");
  const deal = rel("deal");
  const contracts = Array.isArray(raw.contracts) ? (raw.contracts as Record<string, unknown>[]) : [];
  return {
    id: Number(raw.id),
    identifier: raw.identifier ? String(raw.identifier) : null,
    name: String(raw.name ?? ""),
    active: raw.active !== false,
    billable: raw.billable !== false,
    start_date: raw.start_date ? String(raw.start_date) : null,
    finish_date: raw.finish_date ? String(raw.finish_date) : null,
    hourly_rate: raw.hourly_rate == null ? null : Number(raw.hourly_rate),
    currency: raw.currency ? String(raw.currency) : null,
    customer: customer ? { id: Number(customer.id), name: String(customer.name) } : null,
    leader: leader ? { id: Number(leader.id), firstname: String(leader.firstname ?? ""), lastname: String(leader.lastname ?? "") } : null,
    project_group: group ? { id: Number(group.id), name: String(group.name) } : null,
    deal: deal ? { id: Number(deal.id), name: String(deal.name ?? "") } : null,
    tags: Array.isArray(raw.tags) ? (raw.tags as unknown[]).map(String) : [],
    contracts: contracts.map((c) => ({
      id: Number(c.id),
      user_id: Number(c.user_id),
      firstname: String(c.firstname ?? ""),
      lastname: String(c.lastname ?? ""),
      billable: c.billable !== false,
      active: c.active !== false,
      budget: c.budget == null ? null : Number(c.budget),
      hourly_rate: c.hourly_rate == null ? null : Number(c.hourly_rate),
    })),
    updated_at: raw.updated_at ? String(raw.updated_at) : undefined,
  };
}

function pickCompany(raw: Record<string, unknown>): MocoCompany {
  return { id: Number(raw.id), type: (raw.type as MocoCompany["type"]) ?? "customer", name: String(raw.name ?? ""), identifier: raw.identifier ? String(raw.identifier) : null, active: raw.active !== false, updated_at: raw.updated_at ? String(raw.updated_at) : undefined };
}

export function pickDeal(raw: Record<string, unknown>): MocoDeal {
  const rel = (k: string) => (raw[k] && typeof raw[k] === "object" ? (raw[k] as Record<string, unknown>) : null);
  const company = rel("company");
  const user = rel("user");
  const cat = rel("category") ?? rel("deal_category");
  return {
    id: Number(raw.id),
    name: String(raw.name ?? ""),
    status: (String(raw.status ?? "potential") as MocoDeal["status"]),
    money: raw.money == null ? 0 : Number(raw.money),
    currency: String(raw.currency ?? "EUR"),
    reminder_date: raw.reminder_date ? String(raw.reminder_date) : null,
    company: company ? { id: Number(company.id), name: String(company.name ?? "") } : null,
    user: user ? { id: Number(user.id), firstname: String(user.firstname ?? ""), lastname: String(user.lastname ?? "") } : null,
    category: cat ? { id: Number(cat.id), name: String(cat.name ?? "") } : null,
    info: raw.info ? String(raw.info) : null,
    tags: Array.isArray(raw.tags) ? (raw.tags as unknown[]).map(String) : [],
  };
}

function pickDealCategory(raw: Record<string, unknown>): MocoDealCategory {
  return { id: Number(raw.id), name: String(raw.name ?? ""), probability: raw.probability == null ? 0 : Number(raw.probability) };
}

function pickGroup(raw: Record<string, unknown>): MocoProjectGroup {
  const company = raw.company && typeof raw.company === "object" ? (raw.company as Record<string, unknown>) : null;
  const user = raw.user && typeof raw.user === "object" ? (raw.user as Record<string, unknown>) : null;
  return {
    id: Number(raw.id),
    name: String(raw.name ?? ""),
    company: company ? { id: Number(company.id), name: String(company.name) } : null,
    user: user ? { id: Number(user.id), firstname: String(user.firstname ?? ""), lastname: String(user.lastname ?? "") } : null,
    projects: Array.isArray(raw.projects) ? (raw.projects as Record<string, unknown>[]).map((p) => ({ id: Number(p.id), name: String(p.name ?? "") })) : undefined,
  };
}

// ---------------------------------------------------------------------------
// HTTP-Client (Produktion)
// ---------------------------------------------------------------------------

export class HttpMocoClient implements MocoClient {
  readonly kind = "http" as const;
  constructor(private readonly subdomain: string, private readonly apiKey: string, private readonly fetchImpl: typeof fetch = fetch) {}

  /** Lesende Aufrufe: ausschließlich GET. */
  private async get(url: URL | string): Promise<Response> {
    return this.fetchImpl(url, { method: "GET", headers: { Authorization: `Token token=${this.apiKey}`, Accept: "application/json" } });
  }

  /** Der einzige schreibende Aufruf nach Moco: Leads anlegen (`createDeal`). Alles andere – Projekte, Firmen, Personen,
   *  Zuweisungen – bleibt in Moco führend und wird vom Accountmeister nie verändert. */
  private async post(pathname: string, body: unknown): Promise<Response> {
    return this.fetchImpl(`https://${this.subdomain}.mocoapp.com/api/v1/${pathname}`, {
      method: "POST",
      headers: { Authorization: `Token token=${this.apiKey}`, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async getAll(pathname: string, params: Record<string, string | undefined> = {}): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    for (let page = 1; page <= 50; page++) {
      const url = new URL(`https://${this.subdomain}.mocoapp.com/api/v1/${pathname}`);
      for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, v);
      url.searchParams.set("page", String(page));
      url.searchParams.set("per_page", "100");
      const res = await this.get(url);
      if (res.status === 429) {
        // Ratenbegrenzung: kurz warten und dieselbe Seite erneut holen
        await new Promise((r) => setTimeout(r, 5000));
        page--;
        continue;
      }
      if (!res.ok) throw new Error(`Moco ${pathname}: HTTP ${res.status}`);
      const body = (await res.json()) as unknown;
      const rows = Array.isArray(body) ? (body as Record<string, unknown>[]) : [];
      out.push(...rows);
      const total = Number(res.headers.get("X-Total") ?? "0");
      if (rows.length < 100 || (total && out.length >= total)) break;
    }
    return out;
  }

  async users(opts: { includeArchived?: boolean } = {}) {
    return (await this.getAll("users", { include_archived: opts.includeArchived ? "true" : undefined })).map(pickUser);
  }
  async companies(opts: { type?: "customer" | "supplier" | "organization" } = {}) {
    return (await this.getAll("companies", { type: opts.type })).map(pickCompany);
  }
  async projectGroups() {
    return (await this.getAll("projects/groups")).map(pickGroup);
  }
  async projects(opts: { includeArchived?: boolean; updatedFrom?: string } = {}) {
    return (await this.getAll("projects", { include_archived: opts.includeArchived ? "true" : undefined, include_company: "true", updated_from: opts.updatedFrom })).map(pickProject);
  }
  async project(id: number) {
    const url = `https://${this.subdomain}.mocoapp.com/api/v1/projects/${id}`;
    const res = await this.get(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Moco projects/${id}: HTTP ${res.status}`);
    return pickProject((await res.json()) as Record<string, unknown>);
  }
  async dealCategories() {
    return (await this.getAll("deal_categories")).map(pickDealCategory);
  }
  async deals() {
    return (await this.getAll("deals")).map(pickDeal);
  }
  async createDeal(payload: MocoDealCreate) {
    const res = await this.post("deals", payload);
    if (!res.ok) {
      let detail = "";
      try {
        detail = JSON.stringify(await res.json()).slice(0, 300);
      } catch {
        /* keine Details */
      }
      throw new Error(`Moco deals (anlegen): HTTP ${res.status}${detail ? ` – ${detail}` : ""}`);
    }
    return pickDeal((await res.json()) as Record<string, unknown>);
  }
}

// ---------------------------------------------------------------------------
// Fixture-Client (Tests, Entwicklung ohne Moco-Zugang) – liest JSON-Dateien im Format der Moco-API
// ---------------------------------------------------------------------------

export class FixtureMocoClient implements MocoClient {
  readonly kind = "fixture" as const;
  constructor(private readonly dir: string) {}
  private async load(name: string): Promise<Record<string, unknown>[]> {
    try {
      const txt = await readFile(path.join(this.dir, `${name}.json`), "utf8");
      const parsed = JSON.parse(txt) as unknown;
      return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
    } catch {
      return [];
    }
  }
  async users(opts: { includeArchived?: boolean } = {}) {
    const rows = (await this.load("users")).map(pickUser);
    return opts.includeArchived ? rows : rows.filter((u) => u.active);
  }
  async companies(opts: { type?: "customer" | "supplier" | "organization" } = {}) {
    const rows = (await this.load("companies")).map(pickCompany);
    return opts.type ? rows.filter((c) => c.type === opts.type) : rows;
  }
  async projectGroups() {
    return (await this.load("project_groups")).map(pickGroup);
  }
  async projects(opts: { includeArchived?: boolean; updatedFrom?: string } = {}) {
    let rows = (await this.load("projects")).map(pickProject);
    if (!opts.includeArchived) rows = rows.filter((p) => p.active);
    if (opts.updatedFrom) rows = rows.filter((p) => !p.updated_at || p.updated_at.slice(0, 10) >= opts.updatedFrom!);
    return rows;
  }
  async project(id: number) {
    return (await this.load("projects")).map(pickProject).find((p) => p.id === id) ?? null;
  }
  /** Angelegte Leads bleiben nur im Prozess (Tests, Entwicklung); neue IDs ab 90001. */
  private static createdDeals: MocoDeal[] = [];
  async dealCategories() {
    const rows = (await this.load("deal_categories")).map(pickDealCategory);
    return rows.length ? rows : [{ id: 1, name: "Kontakt", probability: 10 }, { id: 2, name: "Qualifiziert", probability: 40 }, { id: 3, name: "Angebot", probability: 70 }];
  }
  async deals() {
    return [...(await this.load("deals")).map(pickDeal), ...FixtureMocoClient.createdDeals];
  }
  async createDeal(payload: MocoDealCreate) {
    const cats = await this.dealCategories();
    const cat = cats.find((c) => c.id === payload.deal_category_id) ?? null;
    const companies = await this.companies();
    const company = companies.find((c) => c.id === payload.company_id) ?? null;
    const user = (await this.users({ includeArchived: true })).find((u) => u.id === payload.user_id) ?? null;
    const deal: MocoDeal = {
      id: 90001 + FixtureMocoClient.createdDeals.length,
      name: payload.name,
      status: payload.status ?? "potential",
      money: payload.money,
      currency: payload.currency,
      reminder_date: payload.reminder_date,
      company: company ? { id: company.id, name: company.name } : null,
      user: user ? { id: user.id, firstname: user.firstname, lastname: user.lastname } : null,
      category: cat ? { id: cat.id, name: cat.name } : null,
      info: payload.info ?? null,
      tags: payload.tags ?? [],
    };
    FixtureMocoClient.createdDeals.push(deal);
    return deal;
  }
}

/** Freelancer in Moco: Mitglied des Freelancer-Teams (Name konfigurierbar; zusätzlich alles, was nach „Freelancer/Extern/Freiberufler“
 *  klingt) oder in Moco als extern (`extern`/`external`) markiert. */
export function isFreelancerMocoUser(u: { unit: { name: string } | null; external: boolean }): boolean {
  const configured = getConfig().MOCO_FREELANCER_UNIT.trim().toLowerCase();
  const unit = (u.unit?.name ?? "").trim().toLowerCase();
  if (unit && unit === configured) return true;
  if (/freelanc|extern|freiberuf|subunternehm|partner/.test(unit)) return true;
  return u.external === true;
}

/** Technische Konten (z. B. der Key-Inhaber) werden nicht als Personen übernommen. */
export function isIgnoredMocoUser(u: { email: string | null; firstname: string; lastname: string }): boolean {
  const ignore = getConfig().MOCO_IGNORE_EMAILS.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (u.email && ignore.includes(u.email.toLowerCase())) return true;
  return /accountmeister|salesagent/i.test(`${u.firstname} ${u.lastname}`);
}

export function mocoEnabled(): boolean {
  const c = getConfig();
  return c.MOCO_MODE === "fixture" || (c.MOCO_MODE === "http" && !!c.MOCO_SUBDOMAIN && !!c.MOCO_API_KEY);
}

export function getMocoClient(): MocoClient {
  const c = getConfig();
  if (c.MOCO_MODE === "fixture") return new FixtureMocoClient(c.MOCO_FIXTURE_DIR);
  if (c.MOCO_MODE === "http") {
    if (!c.MOCO_SUBDOMAIN || !c.MOCO_API_KEY) throw new MocoConfigError("MOCO_SUBDOMAIN und MOCO_API_KEY fehlen.");
    return new HttpMocoClient(c.MOCO_SUBDOMAIN, c.MOCO_API_KEY);
  }
  throw new MocoConfigError("Die Moco-Anbindung ist nicht eingeschaltet (MOCO_MODE=off).");
}

export function mocoDealUrl(dealId: number): string | null {
  const c = getConfig();
  return c.MOCO_SUBDOMAIN ? `https://${c.MOCO_SUBDOMAIN}.mocoapp.com/deals/${dealId}` : null;
}

export function mocoProjectUrl(projectId: number): string | null {
  const c = getConfig();
  return c.MOCO_SUBDOMAIN ? `https://${c.MOCO_SUBDOMAIN}.mocoapp.com/projects/${projectId}` : null;
}
