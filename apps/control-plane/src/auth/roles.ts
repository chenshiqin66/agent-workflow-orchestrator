export const ROLES = ["viewer", "builder", "developer", "admin"] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  builder: 1,
  developer: 2,
  admin: 3,
};

export function parseRole(raw: string): Role | null {
  return (ROLES as readonly string[]).includes(raw) ? (raw as Role) : null;
}

export function roleAtLeast(role: string, minRole: string): boolean {
  const a = parseRole(role);
  const b = parseRole(minRole);
  if (!a || !b) return false;
  return ROLE_RANK[a] >= ROLE_RANK[b];
}

export function requireRole(role: string, minRole: string): void {
  if (!roleAtLeast(role, minRole)) {
    const err = new Error(`requires role ${minRole}+`);
    (err as Error & { status: number }).status = 403;
    throw err;
  }
}
