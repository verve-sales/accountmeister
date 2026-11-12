import { redirect } from "next/navigation";

/** e48: Das CEO-Dashboard ist in der GF-Startseite aufgegangen (Kennzahlen, Kunden mit Health und Datenlage, Pipeline, Team). */
export default function CeoDashboardPage() {
  redirect("/start");
}
