"use client";
import { useEffect } from "react";
import { usePathname } from "next/navigation";

/** Schließt die aufgeklappten Kopfmenüs („Mehr“, Hut) bei Klick daneben, Escape und nach einem Seitenwechsel (e47). */
export function CloseMenus() {
  const path = usePathname();
  useEffect(() => {
    const open = () => Array.from(document.querySelectorAll<HTMLDetailsElement>("details.nav-more[open]"));
    const onDown = (e: Event) => {
      for (const d of open()) if (!(e.target instanceof Node) || !d.contains(e.target)) d.open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") for (const d of open()) d.open = false;
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  useEffect(() => {
    for (const d of Array.from(document.querySelectorAll<HTMLDetailsElement>("details.nav-more[open]"))) d.open = false;
  }, [path]);
  // e64: Sprungziel in einem eingeklappten Abschnitt (z. B. Hilfe-Kapitel) aufklappen
  useEffect(() => {
    const openTarget = () => {
      const id = decodeURIComponent(location.hash.slice(1));
      const el = id ? document.getElementById(id) : null;
      const det = el?.closest("details");
      if (det && !det.open) det.open = true;
    };
    openTarget();
    window.addEventListener("hashchange", openTarget);
    return () => window.removeEventListener("hashchange", openTarget);
  }, [path]);
  return null;
}
