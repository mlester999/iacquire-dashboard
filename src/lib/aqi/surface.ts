const AQI_SURFACE = /^\/(activity|add-ons|analytics|appointments|approvals|crm|inbox|knowledge|leads|maintenance|notifications|our-work|overview|projects|retention|sales|settings|setup|support|website|workforce|admin)(\/|$)/;

/** The global AQi launcher is intentionally absent from dedicated AI Employee Chat routes. */
export function isAqiSurface(pathname: string | null): boolean {
  return Boolean(pathname && AQI_SURFACE.test(pathname));
}
