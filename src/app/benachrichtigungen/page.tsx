import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";
import { listNotifications, notificationKindLabel, type NotificationKind } from "@/modules/notifications/service";
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
  const mailOn = getConfig().MAIL_TRANSPORT !== "off";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">Benachrichtigungen</h1>
        <span className="muted text-sm">{unread.length} ungelesen</span>
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
      <section className="card">
        {list.length === 0 ? (
          <p className="muted text-sm">Noch keine Benachrichtigungen.</p>
        ) : (
          <ul className="space-y-2">
            {list.map((n) => (
              <li key={n.id} className="text-sm flex flex-wrap items-baseline gap-2" style={{ fontWeight: n.readAt ? 400 : 600 }}>
                <span className="muted text-xs" style={{ minWidth: "9.5rem" }}>{fmtDateTime(n.createdAt)}</span>
                <span className="status">{notificationKindLabel[n.kind as NotificationKind] ?? n.kind}</span>
                <form action={openNotificationAction} className="grow" style={{ minWidth: 0, flexBasis: "20rem" }}>
                  <input type="hidden" name="notificationId" value={n.id} />
                  <button type="submit" className="link-button" style={{ background: "none", border: 0, padding: 0, color: "var(--link, #1d4ed8)", textDecoration: "underline", cursor: "pointer", textAlign: "left", fontWeight: "inherit" }}>
                    {n.title}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
