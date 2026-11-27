import { Segmented } from "./ViewSwitch";

/** e77: Die vier Sichten auf dieselben Einsätze als ein Ansichtsschalter (Adressen bleiben). */
export function EinsatzViews({ active, asg }: { active: "zeitleiste" | "liste" | "konditionen" | "checkins"; asg: boolean }) {
  if (!asg) return null;
  return (
    <Segmented
      label="Ansicht der Einsätze"
      items={[
        { href: "/assignments", label: "Zeitleiste", active: active === "zeitleiste" },
        { href: "/einsaetze", label: "Liste", active: active === "liste" },
        { href: "/assignments/konditionen", label: "Laufzeiten & Konditionen", active: active === "konditionen" },
        { href: "/assignments/checkins", label: "Check-ins", active: active === "checkins" },
      ]}
    />
  );
}
