import Link from "next/link";
import { listNotifications, needsAction, notificationKindLabel, type NotificationKind } from "@/modules/notifications/service";
import type { Actor } from "@/modules/identity/actor";
import { fmtDateTime } from "@/lib/labels";
import { markNotificationsReadAction, openNotificationAction } from "@/app/actions";
import { Icon } from "./Icon";

const deDates = (t: string) => t.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_, y, m, d) => `${Number(d)}.${Number(m)}.${y}`);
const urgentRenewal = (t: string) => /^Verlängerung (klären|zu klären|bestätigen|entscheiden|anstoßen)/.test(t) || /^Freigabe: Verlängerung/.test(t);

/**
 * e68: Benachrichtigungen als Klappliste an der Glocke statt eigener Seite – zuerst, was dich braucht (dringend zuerst),
 * dann die übrigen ungelesenen und die jüngsten gelesenen. Ein Klick öffnet das Objekt und markiert gelesen.
 */
export async function NotificationBell({ actor, unread }: { actor: Actor; unread: number }) {
  const list = await listNotifications(actor, 40).catch(() => []);
  const rank = (n: { kind: string; title: string; readAt: Date | null }) => (n.readAt ? 9 : n.kind === "SOS" ? 0 : n.kind === "UEBERFAELLIG" ? 1 : urgentRenewal(n.title) ? 2 : needsAction(n.kind) ? 3 : 4);
  const shown = [...list].sort((a, b) => rank(a) - rank(b) || b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 12);
  const open = list.filter((n) => !n.readAt);
  return (
    <details className="nav-more bell-menu">
      <summary className="icon-btn" aria-label={unread ? `Benachrichtigungen: ${unread} ungelesen` : "Benachrichtigungen"} title="Benachrichtigungen">
        <Icon name="bell" size={19} />
        {unread > 0 && <span className="icon-badge">{unread > 99 ? "99+" : unread}</span>}
      </summary>
      <div className="nav-more-menu bell-pop">
        <div className="bell-head">
          <strong className="text-sm">Benachrichtigungen</strong>
          {open.length > 0 && (
            <form action={markNotificationsReadAction} className="ml-auto">
              <input type="hidden" name="back" value="/start" />
              <button className="btn btn-secondary btn-small" type="submit">Alle gelesen</button>
            </form>
          )}
        </div>
        {shown.length === 0 ? (
          <p className="muted text-sm" style={{ padding: ".5rem .75rem" }}>Keine Benachrichtigungen.</p>
        ) : (
          <ul className="notif-list">
            {shown.map((n) => (
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
        )}
        <div className="bell-foot text-xs">
          {list.length > shown.length && <Link href="/benachrichtigungen">Ältere anzeigen</Link>}
          <Link href="/einstellungen#benachrichtigungen" className="ml-auto">Einstellungen</Link>
        </div>
      </div>
    </details>
  );
}
