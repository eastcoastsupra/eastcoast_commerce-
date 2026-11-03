export const SITES = Object.freeze({
  eastcoastsupra: Object.freeze({
    key: "eastcoastsupra",
    name: "East Coast Supra",
    domain: "eastcoastsupra.com",
    siteId: "c657a976-ab71-452c-b451-6ef24770c9f4",
    catalogVersion: "V1"
  }),
  ecbmw: Object.freeze({
    key: "ecbmw",
    name: "East Coast BMW",
    domain: "ecbmw.com",
    siteId: "82e4ec70-32f8-4d6d-a6a6-e4b582cb5104",
    catalogVersion: "V1"
  })
});

export function selectSites(siteKey) {
  if (siteKey === "all") {
    return Object.values(SITES);
  }

  const site = SITES[siteKey];
  if (!site) {
    const options = [...Object.keys(SITES), "all"].join(", ");
    throw new Error(`Unknown site '${siteKey}'. Use one of: ${options}.`);
  }

  return [site];
}
