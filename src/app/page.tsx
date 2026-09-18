import { redirect } from "next/navigation";
import { getCurrentActor } from "@/modules/identity/session";

export default async function Home() {
  const actor = await getCurrentActor();
  redirect(actor ? "/meine-arbeit" : "/anmelden");
}
