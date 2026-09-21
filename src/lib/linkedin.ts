/**
 * LinkedIn-Referenzen (Etappe 18): keine API-Anbindung – Sales Navigator bietet Drittanbietern keine offene API,
 * ein inoffizieller Zugriff würde gegen die Nutzungsbedingungen verstoßen. Diese Hilfsfunktion baut nur einen
 * Deep-Link zur normalen LinkedIn-Personensuche (Ergebnis lässt sich in Sales Navigator genauso weiterverfolgen);
 * geöffnet wird er ausschließlich vom Browser der Person, die klickt – die Anwendung selbst ruft LinkedIn nie auf.
 */
export function linkedinSearchUrl(...terms: (string | null | undefined)[]): string {
  const keywords = terms.filter((t): t is string => !!t && t.trim().length > 0).join(" ");
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}`;
}
