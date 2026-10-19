// The legacy /sales view is the GoHighLevel read-only sales screen. A client workspace whose opportunities capability is owned by
// iAcquire CRM uses the native opportunities workspace instead. Agency workspaces and GoHighLevel-owned opportunities never redirect.
export function shouldRedirectSalesToNative(input: {
  orgKind: string;
  canViewCrm: boolean;
  opportunitiesNative: boolean;
}): boolean {
  return input.orgKind === "client" && input.canViewCrm && input.opportunitiesNative;
}
