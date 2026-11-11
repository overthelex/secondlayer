// Whether the PBX is configured, for the views (the «Подзвонити» button and the
// events script render only then). Set once at boot, like the tenant.
let enabled = false;

export function setPbxEnabled(on: boolean): void {
  enabled = on;
}

export function pbxEnabled(): boolean {
  return enabled;
}
