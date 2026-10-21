export const DEMO_USERS = [
  { id: "u_dev", label: "Developer (u_dev)", role: "developer" },
  { id: "u_builder", label: "Builder (u_builder)", role: "builder" },
  { id: "u_viewer", label: "Viewer (u_viewer)", role: "viewer" },
  { id: "u_admin", label: "Admin (u_admin)", role: "admin" },
] as const;

export type DemoUserId = (typeof DEMO_USERS)[number]["id"];

export const USER_STORAGE_KEY = "awo.userId";

export function roleForUser(userId: string): string {
  return DEMO_USERS.find((u) => u.id === userId)?.role ?? "viewer";
}

type Props = {
  userId: string;
  onChange: (userId: string) => void;
  disabled?: boolean;
};

export function UserSwitcher({ userId, onChange, disabled }: Props) {
  return (
    <label className="awo-user-switcher">
      <span className="awo-user-switcher__label">用户</span>
      <select
        value={userId}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-label="切换演示用户"
      >
        {DEMO_USERS.map((u) => (
          <option key={u.id} value={u.id}>
            {u.label}
          </option>
        ))}
      </select>
    </label>
  );
}
