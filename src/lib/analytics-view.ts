export interface GrowthPartnerWorkRow {
  role_key: string;
  total: number;
}

/** Keeps current Partner work distinct from preserved role activity without showing retired role names. */
export function growthPartnerWorkRows(rows: readonly GrowthPartnerWorkRow[]) {
  const totalFor = (isPartner: boolean) => rows
    .filter((row) => (row.role_key === "growth_partner") === isPartner)
    .reduce((sum, row) => sum + Math.max(0, Number(row.total) || 0), 0);
  const partner = totalFor(true);
  const previousProfiles = totalFor(false);
  return [
    ...(partner > 0 ? [{ key: "growth_partner", label: "AI Growth Partner", value: partner }] : []),
    ...(previousProfiles > 0 ? [{ key: "previous_profiles", label: "Previous role profiles", value: previousProfiles }] : []),
  ];
}
