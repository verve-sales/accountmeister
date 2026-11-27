import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { listNotifications, needsAction, notificationKindLabel, type NotificationKind } from "@/modules/notifications/service";
import { ensureOverdueNotificationsSafe } from "@/modules/work/service";
import { Feedback, type SearchParams } from "@/components/Feedback";
import { fmtDateTime } from "@/lib/labels";
import { getConfig } from "@/lib/config";
import { markNotificationsReadAction, openNotificationAction } from "../actions";

export default async function BenachrichtigungenPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const actor = await getCurrentActor();
  if (!actor) redirect("/anmelden");
  await ensureOverdueNotificationsSafe(actor);
  const list = await listNotifications(actor, 150);
  const unread = list.filter((n) => !n.readAt);
  // e67: Verlängerungen, die zu klären oder zu entscheiden sind, gehören zu „braucht dich“ – dringende zuerst
  const urgentRenewal = (t: string) => /^Verlängerung (klären|zu klären|bestätigen|entscheiden|anstoßen)/.test(t) || /^Freigabe: Verlängerung/.test(t);
  const rank = (n: { kind: string; title: string }) => (n.kind === "SOS" ? 0 : n.kind === "UEBERFAELLIG" ? 1 : urgentRenewal(n.title) ? 2 : 3);
  const todo = unread.filter((n) => needsAction(n.kind) || urgentRenewal(n.title)).sort((a, b) => rank(a) - rank(b));
  const rest = list.filter((n) => !todo.includes(n));
  const mailOn = getConfig().MAIL_TRANSPORT !== "off";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">Benachrichtigungen</h1>
        <span className="muted text-sm">{todo.length} zu tun · {unread.length - todo.length} weitere ungelesen</span>
        {unread.length > 0 && (
          <form action={markNotificationsReadAction}>
            <input type="hidden" name="back" value="/benachrichtigungen" />
            <button className="btn btn-secondary btn-small" type="submit">Alle als gelesen markieren</button>
          </form>
        )}
        <Link href="/einstellungen#benachrichtigungen" className="text-sm ml-auto">Einstellungen</Link>
      </div>
      <Feedback params={sp} />
      {!mailOn && <p className="muted text-xs">Der E-Mail-Versand ist derzeit ausgeschaltet – Hinweise erscheinen nur hier und an der Glocke.</p>}
      {list.length === 0 && <section className="card"><p className="muted text-sm">Noch keine Benachrichtigungen.</p></section>}
      {todo.length > 0 && (
        <section className="card">
          <h2 className="font-semibold mb-2">Braucht dich ({todo.length})</h2>
          <Rows list={todo} />
        </section>
      )}
      {rest.length > 0 && (
        <section className="card">
          <h2 className="font-semibold">Zur Kenntnis und Erledigtes</h2>
          <p className="muted text-xs mb-2">Zählt nicht an der Glocke. Ist eine Sache erledigt oder hast du sie geöffnet, gilt der Hinweis als gelesen.</p>
          <Rows list={rest} />
        </section>
      )}
    </div>
  );
}

function Rows({ list }: { list: Awaited<ReturnType<typeof listNotifications>> }) {
  return (
    <ul className="notif-list">
      {list.map((n) => (
        <li key={n.id} className="notif" data-unread={n.readAt ? undefined : "true"}>
          <form action={openNotificationAction} className="notif-form">
            <input type="hidden" name="notificationId" value={n.id} />
            <button type="submit" className="notif-open">
              <span className="notif-dot" aria-hidden="true" />
              <span className="notif-body">
                <span className="notif-title">{deDates(n.title)}</span>
                <span className="notif-meta"><span className="status">{notificationKindLabel[n.kind as NotificationKind] ?? n.kind}</span> {fmtDateTime(n.createdAt)}</span>
              </span>
            </button>
          </form>
        </li>
      ))}
    </ul>
  );
}

/** e64: Datumsangaben in Hinweistexten einheitlich deutsch (2026-12-16 → 16.12.2026) */
function deDates(t: string): string {
  return t.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_, y, m, d) => `${Number(d)}.${Number(m)}.${y}`);
}
