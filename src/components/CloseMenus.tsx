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
  return null;
}
