"use client";

import { useFormStatus } from "react-dom";

/** Absende-Knopf mit sichtbarem Warten (Etappe 39): während die Aktion läuft, ist er gesperrt und sagt, was passiert. */
export function PendingButton({ children, busy, className = "btn", name, value, title }: { children: React.ReactNode; busy: string; className?: string; name?: string; value?: string; title?: string }) {
  const { pending } = useFormStatus();
  return (
    <button className={className} type="submit" name={name} value={value} title={title} disabled={pending} aria-busy={pending} style={pending ? { opacity: 0.7, cursor: "wait" } : undefined}>
      {pending ? busy : children}
    </button>
  );
}
