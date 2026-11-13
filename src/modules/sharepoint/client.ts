import { getConfig, type AppConfig } from "@/lib/config";

/**
 * Zugriff auf die SharePoint-Site „Vertrieb und Verträge“ über Microsoft Graph (e45).
 * Die App des Accountmeisters hat über `Sites.Selected` Rechte auf genau diese Site. Graph kann Bibliotheken, Spalten,
 * Ordner, Dateien und Spaltenwerte anlegen, aber keine Rechte für Personen und keine Ansichten – die setzt der Besitzer.
 */

export type SpLibrary = { id: string; name: string };
export type SpItem = { id: string; webUrl: string };
export type SpColumn =
  | { name: string; displayName: string; kind: "text" }
  | { name: string; displayName: string; kind: "date" }
  | { name: string; displayName: string; kind: "choice"; choices: string[] };

export interface SpClient {
  libraries(): Promise<SpLibrary[]>;
  createLibrary(name: string): Promise<SpLibrary>;
  columns(listId: string): Promise<string[]>;
  createColumn(listId: string, col: SpColumn): Promise<void>;
  driveOf(listId: string): Promise<string>;
  /** Ordnerpfad relativ zur Bibliothek („ITERGO/Angebote“); legt fehlende Ebenen an. created = mindestens eine Ebene neu. */
  ensureFolder(driveId: string, path: string[]): Promise<SpItem & { created: boolean }>;
  /** Datei hochladen; gibt es den Namen schon, hängt SharePoint eine Nummer an. */
  upload(driveId: string, folder: string[], fileName: string, bytes: ArrayBuffer): Promise<SpItem>;
  setFields(driveId: string, itemId: string, fields: Record<string, string | null>): Promise<void>;
  /** Inhalt eines Ordners (eine Ebene); fehlt der Ordner, leer. */
  children(driveId: string, path: string[]): Promise<SpEntry[]>;
  item(driveId: string, itemId: string): Promise<SpEntry>;
  /** Datei in einen anderen Ordner derselben Bibliothek verschieben (Ordner wird angelegt); bei Namensgleichheit nummeriert. */
  move(driveId: string, itemId: string, folder: string[]): Promise<SpItem>;
}

export type SpEntry = SpItem & { name: string; folder: boolean; modified: string | null };

export class SharePointError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

const GRAPH = "https://graph.microsoft.com/v1.0";
const seg = (path: string[]) => path.map((p) => encodeURIComponent(p)).join("/");

export class GraphSpClient implements SpClient {
  constructor(private readonly siteId: string, private readonly token: () => Promise<string>) {}

  private async call<T>(method: string, url: string, body?: unknown, raw?: ArrayBuffer): Promise<T> {
    const res = await fetch(url.startsWith("http") ? url : `${GRAPH}${url}`, {
      method,
      headers: { authorization: `Bearer ${await this.token()}`, ...(raw ? { "content-type": "application/octet-stream" } : body !== undefined ? { "content-type": "application/json" } : {}) },
      body: raw ? raw : body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let detail = "";
      try {
        const j = (await res.json()) as { error?: { message?: string } };
        detail = j.error?.message ?? "";
      } catch {
        // kein JSON
      }
      throw new SharePointError(`SharePoint: HTTP ${res.status}${detail ? ` – ${detail.slice(0, 200)}` : ""}`, res.status);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private site() {
    return `/sites/${encodeURIComponent(this.siteId)}`;
  }

  async libraries(): Promise<SpLibrary[]> {
    const r = await this.call<{ value: { id: string; displayName: string; list?: { template?: string } }[] }>("GET", `${this.site()}/lists?$select=id,displayName,list`);
    return r.value.filter((l) => l.list?.template === "documentLibrary").map((l) => ({ id: l.id, name: l.displayName }));
  }

  async createLibrary(name: string): Promise<SpLibrary> {
    const r = await this.call<{ id: string; displayName: string }>("POST", `${this.site()}/lists`, { displayName: name, list: { template: "documentLibrary" } });
    return { id: r.id, name: r.displayName };
  }

  async columns(listId: string): Promise<string[]> {
    const r = await this.call<{ value: { name: string }[] }>("GET", `${this.site()}/lists/${listId}/columns?$select=name`);
    return r.value.map((c) => c.name);
  }

  async createColumn(listId: string, col: SpColumn): Promise<void> {
    const def = col.kind === "text" ? { text: {} } : col.kind === "date" ? { dateTime: { format: "dateOnly", displayAs: "default" } } : { choice: { choices: col.choices, displayAs: "dropDownMenu", allowTextEntry: false } };
    await this.call("POST", `${this.site()}/lists/${listId}/columns`, { name: col.name, displayName: col.displayName, ...def });
  }

  async driveOf(listId: string): Promise<string> {
    const r = await this.call<{ id: string }>("GET", `${this.site()}/lists/${listId}/drive?$select=id`);
    return r.id;
  }

  async ensureFolder(driveId: string, path: string[]): Promise<SpItem & { created: boolean }> {
    let created = false;
    let item: SpItem | null = null;
    for (let i = 1; i <= path.length; i++) {
      const sub = path.slice(0, i);
      try {
        item = await this.call<SpItem>("GET", `/drives/${driveId}/root:/${seg(sub)}?$select=id,webUrl`);
        continue;
      } catch (e) {
        if (!(e instanceof SharePointError) || e.status !== 404) throw e;
      }
      const parent = i === 1 ? `/drives/${driveId}/root/children` : `/drives/${driveId}/root:/${seg(sub.slice(0, -1))}:/children`;
      try {
        item = await this.call<SpItem>("POST", parent, { name: sub.at(-1), folder: {}, "@microsoft.graph.conflictBehavior": "fail" });
        created = true;
      } catch (e) {
        if (!(e instanceof SharePointError) || e.status !== 409) throw e;
        item = await this.call<SpItem>("GET", `/drives/${driveId}/root:/${seg(sub)}?$select=id,webUrl`);
      }
    }
    if (!item) throw new SharePointError("SharePoint: leerer Ordnerpfad");
    return { id: item.id, webUrl: item.webUrl, created };
  }

  async upload(driveId: string, folder: string[], fileName: string, bytes: ArrayBuffer): Promise<SpItem> {
    const r = await this.call<SpItem>("PUT", `/drives/${driveId}/root:/${seg([...folder, fileName])}:/content?@microsoft.graph.conflictBehavior=rename`, undefined, bytes);
    return { id: r.id, webUrl: r.webUrl };
  }

  async setFields(driveId: string, itemId: string, fields: Record<string, string | null>): Promise<void> {
    await this.call("PATCH", `/drives/${driveId}/items/${itemId}/listItem/fields`, fields);
  }

  async children(driveId: string, path: string[]): Promise<SpEntry[]> {
    type G = { id: string; name: string; webUrl: string; folder?: unknown; lastModifiedDateTime?: string };
    try {
      const base = path.length ? `/drives/${driveId}/root:/${seg(path)}:/children` : `/drives/${driveId}/root/children`;
      const r = await this.call<{ value: G[] }>("GET", `${base}?$select=id,name,webUrl,folder,lastModifiedDateTime&$top=200`);
      return r.value.map((x) => ({ id: x.id, name: x.name, webUrl: x.webUrl, folder: !!x.folder, modified: x.lastModifiedDateTime ?? null }));
    } catch (e) {
      if (e instanceof SharePointError && e.status === 404) return [];
      throw e;
    }
  }

  async item(driveId: string, itemId: string): Promise<SpEntry> {
    const x = await this.call<{ id: string; name: string; webUrl: string; folder?: unknown; lastModifiedDateTime?: string }>("GET", `/drives/${driveId}/items/${encodeURIComponent(itemId)}?$select=id,name,webUrl,folder,lastModifiedDateTime`);
    return { id: x.id, name: x.name, webUrl: x.webUrl, folder: !!x.folder, modified: x.lastModifiedDateTime ?? null };
  }

  async move(driveId: string, itemId: string, folder: string[]): Promise<SpItem> {
    const target = await this.ensureFolder(driveId, folder);
    const r = await this.call<SpItem>("PATCH", `/drives/${driveId}/items/${encodeURIComponent(itemId)}?@microsoft.graph.conflictBehavior=rename`, { parentReference: { id: target.id } });
    return { id: r.id, webUrl: r.webUrl };
  }
}

/** Im Speicher, für Entwicklung und Tests (SHAREPOINT_MODE=fixture). Zustand je Prozess. */
type FixtureState = { libs: (SpLibrary & { drive: string; cols: string[] })[]; items: Map<string, { path: string; fields: Record<string, string | null>; file?: boolean }>; seq: number; fail?: string | null };
const g = globalThis as unknown as { __spFixture?: FixtureState };
export function fixtureState(): FixtureState {
  if (!g.__spFixture) g.__spFixture = { libs: [], items: new Map(), seq: 0, fail: null };
  return g.__spFixture;
}
export function resetFixture() {
  g.__spFixture = { libs: [], items: new Map(), seq: 0, fail: null };
}

export class FixtureSpClient implements SpClient {
  private s = fixtureState();
  private next(p: string) {
    this.s.seq++;
    return `${p}${this.s.seq}`;
  }
  private check() {
    if (this.s.fail) throw new SharePointError(this.s.fail, 500);
  }
  private find(path: string) {
    for (const [id, it] of this.s.items) if (it.path === path) return { id, webUrl: `https://fixture.sharepoint.local/${encodeURI(path)}` };
    return null;
  }
  async libraries() {
    this.check();
    return this.s.libs.map((l) => ({ id: l.id, name: l.name }));
  }
  async createLibrary(name: string) {
    this.check();
    const l = { id: this.next("list-"), name, drive: this.next("drive-"), cols: [] as string[] };
    this.s.libs.push(l);
    return { id: l.id, name };
  }
  async columns(listId: string) {
    return this.s.libs.find((l) => l.id === listId)?.cols ?? [];
  }
  async createColumn(listId: string, col: SpColumn) {
    this.s.libs.find((l) => l.id === listId)?.cols.push(col.name);
  }
  async driveOf(listId: string) {
    return this.s.libs.find((l) => l.id === listId)!.drive;
  }
  async ensureFolder(driveId: string, path: string[]) {
    this.check();
    let created = false;
    let last = null as SpItem | null;
    for (let i = 1; i <= path.length; i++) {
      const p = `${driveId}/${path.slice(0, i).join("/")}`;
      let f = this.find(p);
      if (!f) {
        const id = this.next("item-");
        this.s.items.set(id, { path: p, fields: {} });
        f = { id, webUrl: `https://fixture.sharepoint.local/${encodeURI(p)}` };
        created = true;
      }
      last = f;
    }
    return { ...last!, created };
  }
  async upload(driveId: string, folder: string[], fileName: string) {
    this.check();
    await this.ensureFolder(driveId, folder);
    let name = fileName;
    for (let n = 1; this.find(`${driveId}/${[...folder, name].join("/")}`); n++) name = fileName.replace(/(\.[^.]+)?$/, ` ${n}$1`);
    const p = `${driveId}/${[...folder, name].join("/")}`;
    const id = this.next("item-");
    this.s.items.set(id, { path: p, fields: {}, file: true });
    return { id, webUrl: `https://fixture.sharepoint.local/${encodeURI(p)}` };
  }
  async children(driveId: string, path: string[]) {
    this.check();
    const base = `${driveId}/${path.join("/")}`.replace(/\/$/, "");
    const out: SpEntry[] = [];
    for (const [id, it] of this.s.items) {
      if (!it.path.startsWith(`${base}/`) || it.path.slice(base.length + 1).includes("/")) continue;
      out.push({ id, name: it.path.slice(base.length + 1), webUrl: `https://fixture.sharepoint.local/${encodeURI(it.path)}`, folder: !it.file, modified: null });
    }
    return out;
  }
  async item(_driveId: string, itemId: string) {
    this.check();
    const it = this.s.items.get(itemId);
    if (!it) throw new SharePointError("SharePoint: HTTP 404", 404);
    return { id: itemId, name: it.path.split("/").pop()!, webUrl: `https://fixture.sharepoint.local/${encodeURI(it.path)}`, folder: !it.file, modified: null };
  }
  async setFields(_driveId: string, itemId: string, fields: Record<string, string | null>) {
    this.check();
    const it = this.s.items.get(itemId);
    if (it) it.fields = { ...it.fields, ...fields };
  }
  async move(driveId: string, itemId: string, folder: string[]) {
    this.check();
    const it = this.s.items.get(itemId);
    if (!it) throw new SharePointError("SharePoint: HTTP 404", 404);
    await this.ensureFolder(driveId, folder);
    const fileName = it.path.split("/").pop()!;
    let name = fileName;
    for (let n = 1; this.find(`${driveId}/${[...folder, name].join("/")}`); n++) name = fileName.replace(/(\.[^.]+)?$/, ` ${n}$1`);
    it.path = `${driveId}/${[...folder, name].join("/")}`;
    return { id: itemId, webUrl: `https://fixture.sharepoint.local/${encodeURI(it.path)}` };
  }
}

export function sharePointEnabled(cfg: AppConfig = getConfig()): boolean {
  return cfg.SHAREPOINT_MODE !== "off" && (cfg.SHAREPOINT_MODE === "fixture" || !!cfg.SHAREPOINT_SITE_ID);
}

export async function defaultSpClient(cfg: AppConfig = getConfig()): Promise<SpClient> {
  if (cfg.SHAREPOINT_MODE === "fixture") return new FixtureSpClient();
  if (cfg.SHAREPOINT_MODE !== "graph" || !cfg.SHAREPOINT_SITE_ID) throw new SharePointError("SharePoint ist nicht eingerichtet (SHAREPOINT_MODE/SHAREPOINT_SITE_ID).");
  const { graphToken } = await import("@/modules/notifications/mailer");
  return new GraphSpClient(cfg.SHAREPOINT_SITE_ID, () => graphToken(cfg));
}
